import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { setTableNotify } from '../editor/tableEdit';

/** A question (or a notice) waiting on screen — see App's `ask`/`tell`. */
export interface DialogRequest {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /**
   * Turns the dialog into a question with an answer to TYPE (see
   * ConfirmDialog's `input`, which this mirrors).
   *
   * ON `DialogRequest`, unlike `altLabel` below: a field is meaningful to every
   * raiser — a notice raised by `tell` could legitimately want one read back,
   * and nothing about `ask`'s yes/no forbids one either — so declaring it here
   * costs nothing and would only have to be widened later. What it does NOT do
   * is deliver the value: only `askForName` resolves the typed answer, because
   * only its promise has a `string` to resolve with.
   */
  input?: {
    label: string;
    initialValue: string;
    placeholder?: string;
    /** Why this value cannot be accepted, or null. Runs per keystroke, so it
     *  must be synchronous — which is why `handleNewNote` leaves "that name is
     *  taken" to `handleCreateFile`'s async guard rather than checking here. */
    validate?: (value: string) => string | null;
  };
}
export interface AppDialog extends DialogRequest {
  /** The typed answer, for a request carrying an `input`. Every other call site
   *  ignores it — a function of fewer parameters is assignable — so the zero-arg
   *  `onConfirm`s that `ask`, `askChoice` and `tell` build still type-check. */
  onConfirm: (value: string) => void;
  /** Absent on a notice, which has nothing to decline. */
  onCancel?: () => void;
  /** The third answer, and its label, on the one question that has one — see
   *  `askChoice`. Deliberately NOT on `DialogRequest`: ConfirmDialog draws the
   *  third button only when it has both, so an `altLabel` handed to `ask` or
   *  `tell` would type-check and then silently render nothing. */
  altLabel?: string;
  onAlt?: () => void;
  /** Stamped by `raise`, never by a caller — see `dialogSeq`. */
  id?: number;
}

/**
 * The app's own modal questions and notices — and the one slot they share.
 */
export function useAppDialogs() {
  // ── The app's own modal question ────────────────────────────────────────
  // What `window.confirm` used to do, in the app's own dialog (see
  // components/ConfirmDialog). Beyond looking like the rest of the app, a real
  // dialog can say what will actually HAPPEN — a native one gets a single line
  // of unformatted text, so the question could never be more than "are you
  // sure?", while the thing worth knowing is where the file ends up.
  //
  // A promise per question keeps the callers linear, exactly as they read with
  // `confirm()`. The handlers close the dialog before resolving, so a caller
  // that opens another one is never fighting the first for the screen.
  const [dialog, setDialog] = useState<AppDialog | null>(null);

  // The one on screen, for `raise` below. A ref and not the state, because all
  // three helpers must stay STABLE (`notify` reaches every memoized
  // DocumentPane) and reading `dialog` would put it in their deps.
  const dialogRef = useRef<AppDialog | null>(null);
  /** Tells one question from the next. ConfirmDialog is not remounted between
   *  two of them, so it needs this to know its field is now someone else's. */
  const dialogSeq = useRef(0);

  /**
   * Put a question on screen, settling whatever was already there.
   *
   * One slot holds one dialog, and each of these hands back a promise the caller
   * is awaiting — so a second question arriving while one is up used to replace
   * it and leave the first promise pending FOR THE SESSION. Whoever was awaiting
   * it never reached its `finally`, so the in-flight ref it holds (`trashInFlight`
   * covers the question as well as the copy) stayed true and every later Move to
   * Trash and every Trash-bin operation silently did nothing. Reachable: any
   * background job that reports through `tell` — a notebook's PDF export runs for
   * seconds with no overlay — landing while the bin's confirmation is open.
   *
   * Dismissing the displaced one is the honest reading: its question was taken
   * off the screen before it could be answered, so its caller hears "no".
   */
  const raise = useCallback((next: AppDialog) => {
    // Settled FIRST, so that its own `setDialog(null)` cannot land on top of the
    // dialog installed below — both writes batch, and the last one must win.
    const prev = dialogRef.current;
    // A notice, which has no `onCancel`, is acknowledged instead — with the
    // empty string, because a displaced dialog's field is gone with it and
    // nothing was typed into the ones that have none. `askForName` is the only
    // caller that reads the value, and for it this arm is unreachable: it always
    // hands `raise` an `onCancel`, which resolves its promise null.
    if (prev) (prev.onCancel ?? (() => prev.onConfirm('')))();
    const staged = { ...next, id: ++dialogSeq.current };
    dialogRef.current = staged;
    setDialog(staged);
  }, []);

  const settle = useCallback(() => { dialogRef.current = null; setDialog(null); }, []);

  const ask = useCallback((question: DialogRequest) => new Promise<boolean>(resolve => {
    raise({
      ...question,
      onConfirm: () => { settle(); resolve(true); },
      onCancel: () => { settle(); resolve(false); },
    });
  }), [raise, settle]);

  /**
   * A question with THREE answers, for the one place a yes/no cannot say what
   * the reader means: putting something back out of the Trash onto a name that
   * is taken is "replace it", "keep both", or "leave it where it is", and
   * folding either of the first two into the other would decide for them.
   * Escape and a click outside still cancel — the alternative is never a
   * dismissal.
   */
  const askChoice = useCallback((question: DialogRequest & { altLabel: string }) =>
    new Promise<'confirm' | 'alt' | 'cancel'>(resolve => {
      raise({
        ...question,
        onConfirm: () => { settle(); resolve('confirm'); },
        onAlt: () => { settle(); resolve('alt'); },
        onCancel: () => { settle(); resolve('cancel'); },
      });
    }), [raise, settle]);

  /** Report something and wait for it to be read. One button, so Escape and a
   *  click outside mean the same as pressing it. */
  const tell = useCallback((notice: DialogRequest) => new Promise<void>(resolve => {
    raise({ ...notice, onConfirm: () => { settle(); resolve(); } });
  }), [raise, settle]);

  /**
   * Ask for a NAME — what `prompt()` used to be, and the reason none is left in
   * the app (AGENTS.md: the app draws its own dialogs and prefers them to
   * native ones). Resolves the typed answer, or null when the reader backs out.
   *
   * On the same `raise`/`settle` pair as the three above rather than a bespoke
   * overlay, so it inherits the displaced-dialog rule: a question that is taken
   * off the screen before it can be answered resolves — as null here — instead
   * of leaving its caller awaiting for the session.
   *
   * Trimmed on the way out, because every caller would: a name is a file name
   * and the surrounding spaces are a typo, not part of it. `input.validate` is
   * what refuses an empty one, live, while the reader is still typing.
   */
  const askForName = useCallback((question: DialogRequest & { input: NonNullable<AppDialog['input']> }) =>
    new Promise<string | null>(resolve => {
      raise({
        ...question,
        onConfirm: (value: string) => { settle(); resolve(value.trim()); },
        onCancel: () => { settle(); resolve(null); },
      });
    }), [raise, settle]);

  /** Say something went wrong, in the app's own dialog. One button, because
   *  there is nothing to decide. STABLE — it is handed to EditorPane and on to
   *  every memoized DocumentPane, which must not re-render per keystroke. */
  const notify = useCallback((message: string) => {
    if (typeof message !== 'string' || !message.trim()) {
      console.error('An app notice needs a nonempty message:', new Error('Invalid app notice').stack);
    }
    console.error('RDIAG notify', message, new Error().stack); void tell({ title: 'Could not continue', confirmLabel: 'OK', body: message });
  }, [tell]);

  // The same voice, given to the editor subsystem: a refused clipboard read
  // inside a table cell is the only thing that uses it today. ONE call, at the
  // top level, into a module-level setter — src/editor/ must not learn about
  // React, and what it holds has to stay valid for the app's life, because the
  // handler that eventually calls it was baked into a widget several panes ago.
  useEffect(() => { setTableNotify(notify); }, [notify]);

  // Read through refs by callbacks that must keep their identity (the save
  // funnel and everything downstream of it).
  const notifyRef = useRef(notify);
  useEffect(() => { notifyRef.current = notify; }, [notify]);
  const tellRef = useRef(tell);
  useEffect(() => { tellRef.current = tell; }, [tell]);

  return { dialog, dialogRef, ask, askChoice, tell, askForName, notify, notifyRef, tellRef };
}

export type AppDialogs = ReturnType<typeof useAppDialogs>;
export type Ask = AppDialogs['ask'];
export type Tell = AppDialogs['tell'];
export type Notify = AppDialogs['notify'];
