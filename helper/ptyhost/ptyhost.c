/*
 * vaultagent-pty: the frozen PTY host behind VaultAgent's terminal (macOS only).
 *
 * THIS FILE'S BINARY IS FROZEN. Do not edit, and do not rebuild, without a reason
 * that is worth every macOS user's one-time privacy re-grant.
 *
 * Why it exists. macOS (TCC) attributes a shell's access to Documents, Desktop,
 * Downloads, iCloud Drive and Full Disk Access to its "responsible process": the
 * launchd job that started its ancestors. The VaultAgent helper is ad-hoc signed
 * (no certificate, ever), and TCC keys an ad-hoc binary's grants by path AND
 * cdhash, so every helper update silently dropped every grant. This host is its
 * own LaunchAgent (dev.bme.vaultagent.pty) and the parent of every terminal shell,
 * so the grants belong to IT. Its bytes are committed (helper/ptyhost/vaultagent-pty,
 * pinned in PINNED.json, asserted by helper/test/ptyhost.test.ts), embedded into the
 * helper, and never rebuilt by CI: the cdhash, hence every grant, survives updates.
 *
 * Rebuild only deliberately, with helper/ptyhost/build.sh. It is small and
 * session-logic-free on purpose (sessions, mirror and flow control live in the Bun
 * helper) so that it never needs to change.
 *
 * Protocol (unix socket, mode 0600, one session per connection):
 *   every frame is  [u8 type][u32 big-endian payload length][payload]
 *   client -> host  1 spawn   u16 cols, u16 rows, u32 argc, u32 envc, then NUL-
 *                             terminated strings in order: cwd, file (to execve),
 *                             argv[0..argc-1], env[0..envc-1] ("KEY=VALUE")
 *                   2 input   raw bytes for the PTY
 *                   3 resize  u16 cols, u16 rows
 *                   4 kill    hang up the session (SIGHUP, 2 s grace, SIGKILL on the group)
 *   host -> client  1 spawned u32 pid
 *                   2 output  raw bytes from the PTY
 *                   3 exit    i32 code, i32 signal: code is the exit status and
 *                             signal 0 when the shell exited; code is -1 and signal
 *                             the signal number when it was killed by one
 *                   4 error   UTF-8 message (the session ends after it)
 * A client that closes its socket is a kill. Nothing here ever logs terminal bytes.
 *
 * Process model: the accept loop forks one handler per connection, so one session
 * crashing cannot take down the others, and each shell stays a descendant of this
 * binary, which is what keeps the TCC attribution on it.
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#include <util.h>

enum { C_SPAWN = 1, C_INPUT = 2, C_RESIZE = 3, C_KILL = 4 };
enum { H_SPAWNED = 1, H_OUTPUT = 2, H_EXIT = 3, H_ERROR = 4 };

#define MAX_FRAME (4u << 20)   /* a spawn carries the whole environment; ARG_MAX is 1 MiB */
#define OUT_CHUNK 65536
#define GRACE_MS 2000
#define IDLE_MS 10000          /* a connection that never sends a spawn */

static int sig_w = -1, sig_r = -1;   /* self-pipe: SIGCHLD wakes the poll loop */
static int sock = -1, master = -1;
static pid_t child = -1;
static int child_reaped = 0, child_status = 0;

static unsigned char *rbuf;          /* client frames, compacted after each pass */
static size_t rlen;
static size_t inpos;                 /* bytes of the current input frame already written */
static unsigned char obuf[5 + OUT_CHUNK];
static size_t olen, opos;            /* one frame in flight: that is the backpressure */

static uint32_t get32(const unsigned char *p) { return (uint32_t)p[0] << 24 | p[1] << 16 | p[2] << 8 | p[3]; }
static uint16_t get16(const unsigned char *p) { return (uint16_t)(p[0] << 8 | p[1]); }
static void put32(unsigned char *p, uint32_t v) { p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v; }

static void on_chld(int sig) {
    int saved = errno;
    char c = 1;
    ssize_t r = write(sig_w, &c, 1);   /* full pipe = a wakeup is already pending */
    (void)r; (void)sig;
    errno = saved;
}

static void set_nonblock(int fd) { fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK); }

static void queue(unsigned type, const void *payload, size_t len) {
    obuf[0] = type;
    put32(obuf + 1, (uint32_t)len);
    if (len) memcpy(obuf + 5, payload, len);
    olen = 5 + len;
    opos = 0;
}

static void queue_error(const char *msg) {
    if (olen > opos) return;   /* a frame is mid-send: overwriting it would corrupt the stream */
    size_t n = strlen(msg);
    queue(H_ERROR, msg, n > 1000 ? 1000 : n);
}

/* Blocks (poll) until the queued frame is out or the client is gone. Used only to deliver a final error. */
static void flush_blocking(void) {
    while (opos < olen) {
        ssize_t n = write(sock, obuf + opos, olen - opos);
        if (n > 0) { opos += (size_t)n; continue; }
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && errno == EAGAIN) {
            struct pollfd p = { sock, POLLOUT, 0 };
            if (poll(&p, 1, 1000) <= 0) return;
            continue;
        }
        return;
    }
}

static void reap(void) {
    char junk[64];
    while (read(sig_r, junk, sizeof junk) > 0) {}
    if (child > 0 && !child_reaped) {
        int st;
        pid_t r = waitpid(child, &st, WNOHANG);
        if (r == child) { child_reaped = 1; child_status = st; }
    }
}

/* Hang up the PTY, give the session GRACE_MS to leave, then SIGKILL whatever is
 * still in the shell's process group. Reaping the leader last keeps its pid
 * reserved as a pgid, so the final kill cannot hit a recycled number. */
static void teardown(void) {
    if (child <= 0) return;
    if (master >= 0) { close(master); master = -1; }   /* the kernel SIGHUPs the foreground group */
    kill(-child, SIGHUP);
    for (int waited = 0; waited < GRACE_MS; waited += 50) {
        reap();
        if (child_reaped && kill(-child, 0) < 0 && errno == ESRCH) return;
        struct pollfd p = { sig_r, POLLIN, 0 };
        poll(&p, 1, 50);
    }
    kill(-child, SIGKILL);
    if (!child_reaped) { int st; while (waitpid(child, &st, 0) < 0 && errno == EINTR) {} child_reaped = 1; }
}

static void child_exec(char *cwd, char *file, char **argv, char **envp) {
    for (int s = 1; s < NSIG; s++) signal(s, SIG_DFL);   /* SIGPIPE/SIGCHLD ignores survive exec otherwise */
    sigset_t none;
    sigemptyset(&none);
    sigprocmask(SIG_SETMASK, &none, NULL);
    for (int fd = getdtablesize() - 1; fd > 2; fd--) close(fd);   /* the client socket above all */
    struct termios t;
    if (tcgetattr(0, &t) == 0) {   /* IUTF8: the line discipline erases a whole multibyte character, as Terminal.app's */
        t.c_iflag |= IUTF8;
        tcsetattr(0, TCSANOW, &t);
    }
    if (chdir(cwd) != 0 && chdir("/") != 0) {}
    execve(file, argv, envp);
    char msg[256];
    int n = snprintf(msg, sizeof msg, "vaultagent-pty: cannot run %.150s: %s\r\n", file, strerror(errno));
    if (n > 0) { ssize_t r = write(2, msg, (size_t)n); (void)r; }
    _exit(127);
}

/* Parses a spawn payload (modified in place: strings are NUL-terminated already) and forks. */
static int do_spawn(unsigned char *p, uint32_t len) {
    if (len < 13 || p[len - 1] != 0) { queue_error("malformed spawn"); return -1; }
    struct winsize ws = { 0 };
    ws.ws_col = get16(p); ws.ws_row = get16(p + 2);
    if (!ws.ws_col) ws.ws_col = 80;
    if (!ws.ws_row) ws.ws_row = 24;
    uint32_t argc = get32(p + 4), envc = get32(p + 8);
    if (argc == 0 || argc > 65536 || envc > 65536) { queue_error("malformed spawn"); return -1; }
    char **v = calloc((size_t)argc + envc + 4, sizeof *v);
    if (!v) { queue_error("out of memory"); return -1; }
    char **argv = v + 2, **envp = argv + argc + 1;
    char *cwd = NULL, *file = NULL;
    unsigned char *cur = p + 12, *end = p + len;
    for (uint32_t i = 0; i < 2 + argc + envc; i++) {
        if (cur >= end) { free(v); queue_error("malformed spawn"); return -1; }
        char *s = (char *)cur;
        cur += strlen(s) + 1;
        if (i == 0) cwd = s;
        else if (i == 1) file = s;
        else if (i < 2 + argc) argv[i - 2] = s;
        else envp[i - 2 - argc] = s;
    }
    if (cur != end) { free(v); queue_error("malformed spawn"); return -1; }
    argv[argc] = NULL; envp[envc] = NULL;

    pid_t pid = forkpty(&master, NULL, NULL, &ws);
    if (pid < 0) {
        char msg[128];
        snprintf(msg, sizeof msg, "forkpty failed: %s", strerror(errno));
        free(v); queue_error(msg);
        return -1;
    }
    if (pid == 0) child_exec(cwd, file, argv, envp);
    free(v);
    child = pid;
    set_nonblock(master);
    fcntl(master, F_SETFD, FD_CLOEXEC);
    unsigned char b[4];
    put32(b, (uint32_t)pid);
    queue(H_SPAWNED, b, 4);
    return 0;
}

enum { OK = 0, END_SESSION = -1 };

/* Runs every complete frame in rbuf. An input frame the PTY cannot take yet stays
 * put (inpos remembers how far it got) and `*blocked` holds every frame behind it
 * until the master is writable. The socket is still read meanwhile, into rbuf's
 * free room only: a full rbuf is what pushes a stalled shell back on the client,
 * and reading on is what still sees the client hang up. (Measured: with reads
 * stopped, a paste into a program not reading its terminal left the handler and
 * the shell orphaned after the client closed, until that program exited.) */
static int run_frames(int *blocked) {
    size_t off = 0;
    int rc = OK;
    *blocked = 0;
    while (rlen - off >= 5) {
        unsigned char *f = rbuf + off;
        uint32_t len = get32(f + 1);
        if (len > MAX_FRAME) { queue_error("frame too large"); rc = END_SESSION; break; }
        if (rlen - off < 5u + len) break;
        unsigned char *p = f + 5;
        if (f[0] == C_SPAWN) {
            if (child > 0) { queue_error("already spawned"); rc = END_SESSION; break; }
            if (do_spawn(p, len) != 0) { rc = END_SESSION; break; }
        } else if (f[0] == C_KILL) {
            rc = END_SESSION;
            break;
        } else if (child <= 0) {
            queue_error("no session");
            rc = END_SESSION;
            break;
        } else if (f[0] == C_INPUT) {
            while (inpos < len && master >= 0) {
                ssize_t n = write(master, p + inpos, len - inpos);
                if (n > 0) { inpos += (size_t)n; continue; }
                if (n < 0 && errno == EINTR) continue;
                if (n < 0 && errno == EAGAIN) { *blocked = 1; break; }
                inpos = len;   /* EIO: the slave side is gone, the exit is on its way */
            }
            if (*blocked) break;
            inpos = 0;
        } else if (f[0] == C_RESIZE && len == 4 && master >= 0) {
            struct winsize ws = { 0 };
            ws.ws_col = get16(p); ws.ws_row = get16(p + 2);
            ioctl(master, TIOCSWINSZ, &ws);
        }
        off += 5u + len;
    }
    memmove(rbuf, rbuf + off, rlen - off);
    rlen -= off;
    return rc;
}

static void exit_frame(void) {
    unsigned char b[8];
    int code = -1, sig = 0;
    if (WIFEXITED(child_status)) { code = WEXITSTATUS(child_status); }
    else if (WIFSIGNALED(child_status)) { sig = WTERMSIG(child_status); }
    put32(b, (uint32_t)code); put32(b + 4, (uint32_t)sig);
    queue(H_EXIT, b, 8);
}

static void handle(void) {
    rbuf = malloc(MAX_FRAME + 5);
    if (!rbuf) _exit(1);
    int pipefd[2];
    if (pipe(pipefd) != 0) _exit(1);
    sig_r = pipefd[0]; sig_w = pipefd[1];
    set_nonblock(sig_r); set_nonblock(sig_w); set_nonblock(sock);
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_chld;
    sa.sa_flags = SA_RESTART | SA_NOCLDSTOP;
    sigaction(SIGCHLD, &sa, NULL);

    int blocked = 0, client_gone = 0, finishing = 0;
    for (;;) {
        if (olen > 0 && opos == olen) {
            olen = opos = 0;
            if (finishing) break;
        }

        /* The shell is gone: hand over what it left in the PTY, then report the exit. */
        if (child_reaped && !finishing && olen == 0) {
            ssize_t n = master >= 0 ? read(master, obuf + 5, OUT_CHUNK) : 0;
            if (n > 0) { obuf[0] = H_OUTPUT; put32(obuf + 1, (uint32_t)n); olen = 5 + (size_t)n; opos = 0; }
            else if (n < 0 && errno == EINTR) continue;
            else { exit_frame(); finishing = 1; }   /* EOF, EIO or EAGAIN: nothing left */
        }

        struct pollfd fds[3];
        fds[0].fd = sock;
        fds[0].events = (!client_gone && rlen < MAX_FRAME + 5 ? POLLIN : 0) | (olen > opos ? POLLOUT : 0);
        /* The PTY is read only while no output frame is in flight: a client that
         * stops reading leaves the child blocked in the kernel, not buffered here. */
        fds[1].events = (olen == 0 && !child_reaped ? POLLIN : 0) | (blocked ? POLLOUT : 0);
        fds[1].fd = master >= 0 && fds[1].events ? master : -1;
        fds[2].fd = sig_r;
        fds[2].events = POLLIN;
        for (int i = 0; i < 3; i++) fds[i].revents = 0;
        int n = poll(fds, 3, child > 0 ? -1 : IDLE_MS);
        if (n < 0) continue;   /* EINTR */
        if (n == 0) break;     /* a connection that never sent a spawn */

        if (fds[2].revents & POLLIN) reap();
        if (fds[1].revents & (POLLIN | POLLHUP | POLLERR) && olen == 0 && !child_reaped) {
            ssize_t r = read(master, obuf + 5, OUT_CHUNK);
            if (r > 0) { obuf[0] = H_OUTPUT; put32(obuf + 1, (uint32_t)r); olen = 5 + (size_t)r; opos = 0; }
            else if (r == 0 || (r < 0 && errno == EIO)) { close(master); master = -1; }   /* every slave closed; SIGCHLD follows */
        }
        if (olen > opos && fds[0].revents & POLLOUT) {
            ssize_t w = write(sock, obuf + opos, olen - opos);
            if (w > 0) opos += (size_t)w;
            else if (w < 0 && errno != EAGAIN && errno != EINTR) client_gone = 1;
        }
        if (fds[0].revents & (POLLERR | POLLNVAL)) client_gone = 1;
        if (fds[0].revents & (POLLIN | POLLHUP) && !client_gone) {
            if (rlen < MAX_FRAME + 5) {
                ssize_t r = read(sock, rbuf + rlen, MAX_FRAME + 5 - rlen);
                if (r > 0) rlen += (size_t)r;
                else if (r == 0 || (errno != EAGAIN && errno != EINTR)) client_gone = 1;
            } else if (fds[0].revents & POLLHUP) {
                client_gone = 1;   /* no room to read into, and nobody left to read from */
            }
        }
        if (client_gone) { teardown(); _exit(0); }
        if ((!blocked && rlen >= 5) || (blocked && fds[1].revents & POLLOUT)) {
            if (run_frames(&blocked) == END_SESSION) {
                teardown();
                flush_blocking();   /* the error frame, if one was queued */
                _exit(0);
            }
        }
    }
    _exit(0);
}

int main(int argc, char **argv) {
    const char *path = NULL;
    for (int i = 1; i + 1 < argc; i++)
        if (strcmp(argv[i], "--socket") == 0) path = argv[i + 1];
    struct sockaddr_un addr;
    if (!path || strlen(path) >= sizeof addr.sun_path) {
        fprintf(stderr, "usage: vaultagent-pty --socket <path> (at most %zu bytes)\n", sizeof addr.sun_path - 1);
        return 2;
    }
    signal(SIGPIPE, SIG_IGN);
    signal(SIGCHLD, SIG_IGN);   /* the handlers' exits reap themselves */

    int lsock = socket(AF_UNIX, SOCK_STREAM, 0);
    if (lsock < 0) { perror("socket"); return 1; }
    memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;
    strcpy(addr.sun_path, path);
    unlink(path);   /* a stale socket from a killed host */
    mode_t old = umask(077);   /* restored below: shells inherit this process's umask */
    int rc = bind(lsock, (struct sockaddr *)&addr, sizeof addr);
    umask(old);
    if (rc != 0 || chmod(path, 0600) != 0 || listen(lsock, 16) != 0) { perror("bind"); return 1; }
    fcntl(lsock, F_SETFD, FD_CLOEXEC);

    for (;;) {
        int c = accept(lsock, NULL, NULL);
        if (c < 0) {
            if (errno == EINTR || errno == ECONNABORTED) continue;
            if (errno == EMFILE || errno == ENFILE) { usleep(100000); continue; }
            perror("accept");
            return 1;
        }
        pid_t pid = fork();
        if (pid == 0) {
            close(lsock);
            sock = c;
            handle();
        }
        close(c);
    }
}
