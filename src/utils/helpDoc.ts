export const HELP_DOC_CONTENT = `# Browser Markdown Editor User Guide

Welcome to your Browser Markdown Editor. This application is a fully offline, local-first markdown editor that operates entirely within your web browser using the native File System Access API. 

Because it operates locally, you retain complete ownership and privacy over your data. There are no servers, no databases, and no cloud syncing happening in the background. Your files remain exclusively on your device. The one optional exception is **VaultAgent**, a small helper you can install on your computer: it runs the **AI agent** (section 9), which sends your questions — and what you are looking at — to its own AI service, exactly as it would from your terminal, and the built-in **Terminal** (section 10).

Here is everything you need to know about using the application.

---

## 1. Vault Management

### What is a Vault?
A "Vault" is simply any folder on your computer that you choose to open with this application. When you click "Open local folder (Vault)", the browser asks for your permission to read and write to that specific directory.

### Switching Vaults
The vault switcher at the bottom of the sidebar — the open vault's name, with a small up-and-down arrow beside it — remembers every folder you have opened as a vault. Hover it to see the vault's name and how many files and folders it holds.
- **Click** it to open your recent vaults above it and pick one — no file dialog involved. Click it again (or anywhere else) to close the list.
- **Double-click** it to browse for a folder instead (or choose "Open folder…" at the bottom of that list). Anything you open this way joins the list.
- Vaults are listed newest first, by folder name alone; two vaults whose folders share a name show the parent folder too. Settings → Vault controls how many are listed.
- The browser tab is titled with the name of the vault you have open, so tabs on different vaults are easy to tell apart. Turn **Vault name as tab title** off in Settings → Vault and the tab keeps the title "Markdown Editor" instead.
- The **pin** at the right of a row keeps that vault at the top of the list and lists it however short you set "Recent vaults shown" — the two or three folders you actually live in, above the ones you opened once. A pinned vault is also never dropped when the stored list reaches its limit. Click the pin again to unpin it.
- The **minus** at the left of a row takes that vault off the list, so the folders you actually switch between are not buried under ones you opened once. It forgets the row only — the folder and everything in it stays exactly where it is, and opening it again puts the row back. There is no minus beside the vault you have open, because the app re-lists that one every time it loads. (From the keyboard: **Delete** on the highlighted row does the same thing.)

Any folder can be a vault, including one inside another vault: opening \`Notes/Maths\` gives you a vault of its own, separate from \`Notes\`. You do not need the file dialog for that — right-click the folder in the file tree and choose **Open as Vault**, and it opens as the vault straight away and joins the recent list, so the vault switcher is the way back out.

Switching vaults puts away the notes you had open (saving anything unsaved first), since those files belong to the vault you just left — but it does not forget them. While a PDF's annotations are still being saved, the vault stays open and a message says why; switch again once they are saved. Each vault remembers its own, so switching back brings that vault's panes, the tabs in each of them, the pane widths and the note you were reading straight back, without your reopening a thing — and so does reloading the page. A note you deleted from disk in the meantime is simply not among them; one that is there but can't be read at that moment still comes back, as a tab that says so (see **Tabs** below). That memory lives in this browser, beside the recent-vaults list, which is why taking a vault off that list forgets its tabs along with the row. **The chat you had open in the AI panel comes back the same way**, with everything that was said in it — reloading the tab no longer drops you into a blank new chat — and so does a message you had typed but not sent.

Because all of that lives in this browser rather than on a server, a browser short of space is allowed to clear it: your vault list (the permission to reach those folders, which is the part you cannot simply retype), your open tabs, your settings and the recovery copies of unsaved edits. **Settings → Vault → "Keep this data on this device"** says which footing you are on and asks the browser to keep it. Browsers grant that to sites you use often rather than on request, so if it says no, it is worth asking again after installing this app from the address bar, bookmarking it, or a few more visits. The app does not warn you about this while you work; this setting is the one place it is shown. Your folders themselves are never at risk — they are files on your disk, and the worst case is finding them in the folder picker again.

If another window resets this app’s local settings, a separate browser-local backup restores your settings, open-tab sessions and saved reading positions automatically. A status-line message says **Settings restored after another tab reset them**. A reset discovered while opening the app brings back your settings only — not which tabs were open or where you were reading, since the backup of those may be older than what you have now — and may reload the app once before your workspace appears; if the backup does not answer within a moment, the app starts with the settings as they are and tries again next time. This backup does not survive clearing all of the site’s browser data.

**If opening your vault takes more than a few seconds,** the loading screen says what it is waiting for — reading your recent vaults from the browser’s storage, asking the browser whether the folder may still be opened, or reading the vault’s folders, with how many it has read so far and the folder it is waiting on — and offers **Keep waiting**, **Open another vault…** (when the wait is on a folder) and **Reload**. A folder that does not answer is usually on a cloud drive that has not downloaded it yet, a network share, or a disk that is asleep or disconnected; opening it in Finder or File Explorer can wake it. If a folder of the vault cannot be read at all, the app names it and gives the browser’s reason instead of showing an empty sidebar, and if the vault’s own folder is no longer there (moved, renamed, deleted, or on a drive that is not connected) it says so; nothing is changed, your saved tabs are kept, and **Try again** reads the vault again once you have fixed it.

### Security & Permissions
Modern browsers require you to explicitly grant permission every time you open a vault or sometimes when returning to the application after a session. This is a deliberate security feature of the File System Access API to ensure websites cannot silently access your hard drive.

---

## 2. File Organization & Navigation

### The Sidebar
Along the top of the sidebar sit two tabs — **Files** (the folder) shows the file tree and **Search** (the magnifying glass) searches the vault — with the button that hides the sidebar at the right-hand end (\`Cmd + \\\` / \`Ctrl + \\\` does the same; the button left behind on the thin strip brings it back).

If the search index loses access to the vault, a notice appears above the workspace. Choose **Retry** to grant access again and refresh the index; your notes stay untouched. The index keeps a browser-local copy of note text and links to make reopening faster; removing a vault from the recent list also removes its index. If an outside edit kept exactly the same file size and modification time, open the vault menu and choose **Rebuild index** to read the files again.

Under the tabs, while the file tree is showing, is a row of buttons for the tree itself: **New note**, **New folder**, the **pencil** (its menu holds **New Drawing** and **New Notebook**), **Change sort order**, **Auto-reveal current file** and **Expand all** / **Collapse all** (see *Sorting and Finding Your Place* below).

At the bottom, a row of five icons: **Neural Brain** (the graph view of how your notes link — press it again to get back to the editor), the **AI agent** (the sparkles — see section 9), the **Terminal** (see section 10), the **Trash** bin (see *The Trash Bin*) and the **light/dark mode** switch. Under them is the vault switcher (see *Switching Vaults*), with **Help** (the question mark, which opens this guide) and **Settings** (the gear) on its right. Hover any of these buttons for a moment and a label says what it does.

In **Settings → About**, the third-party notices link lists the software included with the app. **Show developer settings** reveals experimental engine controls; engine changes apply when you next open a pane. **PDF platform layer** previews the new renderer in the classic PDF viewer; the classic view remains available if the preview cannot attach. Only engines included in this build are offered. An emergency read-only switch for each native canvas kind permits viewing, copying and export but prevents edits and saves. **Incremental live preview** can be turned off to recalculate a whole note on each change. Turning developer settings off restores the normal engine choices without deleting your saved selections.

An earlier version of this app converted older drawings and notebooks in place, keeping the old file in Trash; this version never does (see *Drawings*). The old file is in the Trash of the folder the drawing or notebook was in when it was converted, under the same name. To get it back, right-click the converted drawing or notebook and choose **Restore the copy from before conversion** (only a file converted that way, or a PDF, offers it). That version kept no record of the backup, so the app finds it by what the converted file still holds of the old one — its shapes, its text and the view it was saved with — and restores it as a separate file under a free name, beside the converted one; it leaves the converted file and the backup alone. If two different files in Trash both fit, it restores neither and says so: restore the one you want from Trash yourself. A converted PDF offers the same, from its annotation view. In Trash, **Restore a copy** likewise copies a selected file back without consuming it or replacing an existing file.

**Settings → Editing → Board dictionary → Manage** lists the words saved for board spelling in this browser. Use **Remove** beside a word to remove it; the list is shared by boards across vaults, not saved inside a vault.

When a newer app version is available, a notice offers **Reload**. It saves what is still pending first, a change still landing from a key you just pressed included (a nudge, a paste, a duplicate, a turn); if a document still has unsaved changes, a disk conflict or a stroke you are still drawing, the app does not reload and says so. Drawings, notebooks, PDFs and books that are already open keep working and saving until you reload. Opening something whose part of the app was replaced on the server by the newer version shows the same notice, and that pane says **A new version of the app is available** with a **Reload** of its own; an action that needs such a part says so instead of doing nothing. Publishing the same version again does not raise the notice.

If one pane or panel cannot be drawn — or a part of the app cannot be downloaded — only that pane or panel says so, with **Try again**; your other documents and the rest of the app keep working. If the app as a whole hits an error, its screen offers **Save and reload**, which writes your pending edits before reloading and does not reload over edits it could not save.

In Neural Brain, drag a note to move it, drag the background to pan, and use the wheel to zoom toward the pointer. **Reset view** frames the graph again. **Indexing your notes…** means the graph is being built; **Updating…** marks a graph while its index catches up. Small graphs retain the exact layout calculation; graphs with more than 600 nodes use approximate repulsion, so their arrangement can differ slightly without changing any notes or links.

### File Tree
The left sidebar displays your vault's folder structure. You can click on any note to open it in the editor.

### Sorting and Finding Your Place
**Change sort order** (the arrow beside the lines) lists the tree by **File name (A to Z)**, **File name (Z to A)**, **Modified time (new to old)**, **Modified time (old to new)** or **Custom**; the tick shows the one in use, and the app remembers it. Under all but Custom, folders stay at the top, in name order. Under a modified-time order a note moves to the top the moment it saves. Moving or renaming a file counts as modifying it, since the app copies it to its new place. There is no "created time" order: browsers do not tell a web page when a file was created.

**Custom** is your own order: drag files and folders into whatever arrangement you like, folders mixed in among the files if you want (see *Drag and Drop*). Until you move something, a folder looks just as it does under File name (A to Z). Anything added later — a new note, something put back from the Trash — appears at the end of its folder until you place it. The order is kept in the hidden \`.appearance.json\` inside each folder you have arranged, so it travels with the vault and with the folder; choosing another sort order leaves it untouched, and choosing **Custom** again brings it straight back.

**Auto-reveal current file** is an on/off switch, off to begin with. While it is on (its button stays shaded), whatever you switch to in the editor is found in the tree for you: the folders it is in open, and its row scrolls into view. It acts when you change notes (and when you turn it on, or come back to Files from Search) — never on its own after that, so a folder you close yourself stays closed.

Tab to the file tree and use the **Up** and **Down** arrows to move between rows. **Right** opens a folder or moves into it; **Left** closes it or moves to its parent. **Enter** or **Space** opens a file or toggles a folder.

**Expand all** opens every folder in the vault, at every depth. Once any folder is open the same button becomes **Collapse all**, which closes them all again.

Notes are listed under the name you gave them, without the \`.md\` — \`Recipes.md\` on disk reads **Recipes** here, and in its tab. Everything else keeps its extension, so a PDF, a whiteboard and a notebook still say what they are. Hover a row to see its full path, extension and all. Renaming a note shows you the full \`.md\` name again, with just the part before the dot selected, so the extension is there to keep or change deliberately.

### Links to a Note
The address bar tracks what is open — \`#vault=Notes&file=Math/HW1.md\` — so you
can copy it at any moment and get back to exactly that note. Paste one into a new
tab, bookmark it, or put it in another note.

Opening a link never costs you your tabs. The vault comes back with every pane and
every tab you had open in it, sized the way you left them, and the note the link
names is brought to the front — added as one more tab if it was not open already.
Reloading the page is the same thing, since the address bar is a link to what you
were reading. The note half of a link only counts in the vault the link names: if
that vault cannot be found and another one opens instead, it opens just as you
left it, and opening the vault the link names afterwards — without reloading the
page — still brings its note to the front.

A link works on the machine and browser you opened the vault in. Browsers do not
let a page open a folder just because it can name one, so what a link carries is
not a location on your disk: it is the name of a vault this browser has already
been given access to. Opening a link to a vault whose permission has lapsed shows
a single **Open '<vault>'** button, because only a click can ask for that access
back. On a machine that has never opened the vault, the link cannot find it yet:
open that folder — **Open Vault**, or **Open folder…** in the vault menu — and the
note the link names opens with it. From then on the link finds the vault by itself.

### Giving a File or Folder an Icon and a Colour
Right-click anything in the sidebar — a folder, a note, a notebook, a drawing —
and choose **Choose icon / colour**. A panel opens beside the menu with eight
colours and a search box over all 1,818 Lucide icons; it opens on the ones people
usually want (folders, books, flasks, code, work), and typing a word finds the
rest. Picking is live: the row in the sidebar changes as you click, so you can
judge it against the real tree before dismissing the menu.

Clicking the icon something already has removes it, and **Reset to default** puts
the row back to normal. The colour tints the icon only — the name keeps the
normal text colour, so the tree still reads as a list.

On a file, the colour is usually the part you want: a file's icon already says
what it is (a note, a notebook, a drawing), so replacing it is offered but never
the default.

This is remembered in a hidden \`.appearance.json\` inside the folder the thing
sits in, so the icons travel with the vault rather than living in one browser.
Because a look is kept beside what it describes, opening a folder on its own —
from Finder, or with **Open as Vault** — shows exactly the icons it showed from
the whole vault, and anything you change in there is there when you go back out.
Renaming or moving something takes its icon along — a folder's carries everything
inside it — and trashing it forgets it. Icons set in an older version of the app
move across by themselves the first time you open the vault.

A folder you have also opened as a vault shows the same icon in the vault menu,
so the list you switch vaults with looks like the tree you set up.

### Searching the Vault
The **Search** tab at the top of the sidebar looks through every note in the
vault — file names *and* the text inside them — and replaces the file tree while
it is open; the **Files** tab beside it brings the tree back. Picking a result
opens that note and scrolls to the line it matched, then puts the tree back. EPUBs, notebooks, drawings and PDFs match on their names only, since what is in
them is not text. Results appear as the vault is searched. **Indexing — n of N** shows progress while the index or first text search loads. An open note's current text is searched before its saved version, and results refresh as you edit; saved changes remain searchable after the note closes.

### Drag and Drop
Files dropped on an area that does not handle them are refused rather than opened in a browser tab. Links dropped outside editable fields are likewise refused when no area handles them. Dropping a Markdown file onto an editable note can replace its text, as described below.

You can drag and drop files and folders within the file tree to reorganize your vault:
- Drag any item and drop it onto a folder to move it inside that folder.
- Drag any item and drop it onto the empty space in the sidebar (the root level) to move it back to the main vault directory.
- Folders highlight with a purple dashed outline when you hover over them while dragging.

Under the **Custom** sort order, dragging also rearranges the tree, and a line shows where the item will land before you let go:
- Over the top or bottom half of a row, the line appears above or below it — drop to put the item there.
- Over the middle of a folder, the folder gets the purple outline instead — drop to put the item at the end of that folder.
- Over the bottom of an open folder, the line appears indented under its name — drop to make the item the first thing inside it.
- Below the last row, the whole tree is outlined — drop to put the item at the end of the vault's top level.
- Dropping between rows of another folder moves the item into that folder, at that spot. Where no line or outline appears, the drop would change nothing, and does nothing.

Renaming or moving a folder takes the notes you have open from it along: they stay open, keep their place, and go on saving to the right file under its new name.

### Creating New Items
Use the buttons under the tabs at the top of the sidebar: **New note**, **New folder**, and the **pencil**, whose menu offers **New Drawing** and **New Notebook** (click the pencil again, or anywhere else, to close that menu). When creating a new file:
- It will be created in the root vault folder if nothing is selected.
- If you have a file or folder selected, it will be created in the same directory as that selection.
- New files will automatically open and place you in **Edit Mode**.

To create something *inside* a particular folder, right-click that folder (or use the small icons that appear on its row) and choose **New note** or **New folder**. Either way you type the name into a small input row inside the folder itself, and a name that folder already uses is refused rather than overwriting what is there. See **Right-click** below.

---

## 3. Tabs and Panes

### Tabs
Every file you open gets a tab along the top of the editor. A note's tab shows its name without the \`.md\`, like the file tree does; hover a tab to see the file's full path. Tabs can be dragged along the strip to reorder them, closed with the × (or a middle-click), and they come back where you left them the next time you open the app — and, because every vault keeps its own set, whenever you come back to that vault. A dot on a tab means it has changes that haven't been written to disk yet — they will be, a second after you stop typing.

At the right of the strip sit two small buttons. **+** starts a new note — it asks for the name in the app's own box, the same one \`Cmd + N\` / \`Ctrl + N\` opens — and puts it in front of you. **⌄** lists everything open in the strip, so you can jump to a tab whose name has scrolled out of sight. Like every drop-down menu in the app, pressing its button again closes it, and so does clicking anywhere else.

Tabs keep a comfortable width while there is room for it, however short their names are. Open enough of them and they share the strip out between themselves, getting narrower so more stay in sight; past that the strip scrolls, and its left edge fades rather than cutting a name off mid-letter. That sharing happens per pane, so splitting the editor squeezes a pane's tabs straight away, and they widen again as the pane does.

You can move between tabs without the mouse. \`Option + Tab\` (\`Alt + Tab\` on Windows) goes to the next open document and \`Option + Shift + Tab\` to the previous one, walking every pane's tabs in the order they are drawn, left column first, and wrapping round at the end. \`Option + Shift + W\` closes the document in front of you, and \`Option + Shift + T\` puts the last one you closed back; press it again for the one before that. Reopened documents are read from disk again, and a file that has since been renamed or trashed is skipped rather than coming back empty.

Clicking a tab puts the keyboard on that note, so \`Space\`, \`Page Down\` and the arrow keys scroll it straight away, in Read Mode and while editing. To type, click in the text — or, in Edit Mode, press \`Tab\`, which puts the cursor at the end of the first line of text on screen (or leaves it where it is, if it is already on screen; with only a table or picture on screen, scroll a little first).

If a note can't be read when your tabs come back — another program is writing it, a synced file isn't downloaded yet, or it's locked — or does not answer within ten seconds, its tab still comes back, marked with a warning sign, and says so instead of showing the note. The other tabs do not wait for it, and if the help guide cannot be loaded its tab comes back the same way. Nothing in the file is changed. Press **Try again** once it is readable, or click the note in the file tree, which tries again too. It stays among your saved tabs either way; only a note that is really gone from the vault is dropped.

### Putting Two Notes Side by Side
The editor can be split into columns — **panes** — side by side, and each pane keeps a strip of tabs of its own:

1. Drag a tab down out of its strip and over the page.
2. A purple outline shows which half of the page it will take — drop it there.

That document leaves the strip it was in and opens a pane of its own, with its own tab strip above it. Keep going and you can have up to **five** panes at once; each new one is slotted wherever you drop it, and the columns start out sharing the width evenly.

Anything can go in a pane: two notes, a note beside a PDF you are reading, a whiteboard beside the notes you are taking from it.

### Moving Tabs Between Panes
Each pane's tabs are its own, and you switch between them by clicking, exactly as with one pane. To move a document from one pane to another, drag its tab into the other pane's strip and drop it where you want it to sit. Dragging a tab **within** its own strip just reorders it.

A pane's **+** opens its new note in that pane, and its **⌄** lists that pane's tabs.

Closing a tab with its × closes just that document. Closing a pane's **last** tab closes the pane too, and the columns beside it share out the room it was using. A drawing, notebook or annotated PDF closed right after a change — a nudge with the arrow keys, a paste, a delete of many items — first lets that change land, with its tab still open (the status line says **Finishing your last change before closing…** if that takes a moment), then saves and closes. If it cannot be saved, the tab stays open with your changes, the app saves it again by itself a moment later, and it tells you; close it once it shows **Saved**.

### The Pane Header
Under each pane's tabs is a row belonging to that pane: its file's name in the middle, a note's without the \`.md\` as in the tab strip.

- **←** and **→** walk that pane back and forward through the documents it has shown, the way a browser's do. Each pane remembers its own, and only for as long as the app is open — after a reload both arrows start out greyed, because there is nowhere yet to go back to.
- The **eye** button switches that pane between Read Mode and Edit Mode (\`Cmd + E\` / \`Ctrl + E\` does the same to the pane you last clicked in). On a PDF you can annotate, it switches between reading and drawing on it instead. A whiteboard, a notebook, this guide and a note that could not be read have no such button.
- **⋯** holds what is left: **Insert table…** in a note, **Read extracted text**, **Original PDF** and **Print…** on a PDF, **Export to PDF** on a notebook, and **Close this pane**, which closes the pane and everything open in it.

With more than one pane, the pane you last clicked in is the one with the coloured underline, and it is the one that ⌘E, ⌘F and ⌘S act on. Every pane is a real editor: you can type in all of them, and each keeps its own undo history.

### The Status Bar
A small bar sits at the bottom right, over the page, and describes the pane you last clicked in: how many notes link to it (click it for the list), how many words and characters it holds, and whether your changes have been written to disk. The counts follow your typing without delay. It never takes a click meant for the note underneath it. A PDF, drawing, notebook or code file has no words worth counting, so there the bar shows only briefly, to say something was saved or moved to the Trash — and when a PDF or notebook is open in the right-most pane, the bar sits just above its page and zoom buttons rather than over them.

### Giving One Pane More Room
The line between two panes can be dragged. Pull it left or right and those two panes share the width between them — everything else stays exactly where you put it. A pane won't shrink past being readable, so you can always find the line again.

**Double-click** a line to put every pane back to equal widths. You can also click a line and nudge it with the **←** and **→** arrow keys, holding Shift to move it further at a time.

The widths you set are remembered along with the panes, and come back the next time you open the app.

---

## 4. Editing Modes & Auto-Save

### Edit Mode vs. Read Mode
The application features two distinct viewing modes:
- **Read Mode (Default):** Files open in this mode by default. Markdown syntax is fully rendered and hidden, and the document is locked from accidental edits. You can still select, copy and search it with \`Cmd + F\` / \`Ctrl + F\` (see *Finding Text in a Note*).
- **Edit Mode:** Clicking the toggle button (or pressing \`Cmd + E\` / \`Ctrl + E\`) switches the editor to Edit Mode. You can now type and edit.

Reading is the mode in which a link is a link: in Read Mode a web address is clickable, and in Edit Mode it is text you can edit. See *Links*.

**Dropping a Markdown file onto a note.** Drag a \`.md\` file from your computer onto a note in Edit Mode and the note's text is replaced by the file's; \`Cmd + Z\` / \`Ctrl + Z\` in the note brings the old text back. A note in Read Mode is never replaced this way — the application tells you so instead, and \`Cmd + E\` / \`Ctrl + E\` switches to editing.

### Live Preview
Even in Edit Mode, the editor uses a "Live Preview" system. Markdown syntax (like bold asterisks or heading hashes) is hidden on lines you are not actively editing. When your cursor moves to a line, the raw syntax is revealed so you can modify it.

Two things are deliberately never revealed that way, because they are objects rather than text: an **embedded image** and a **table**. Putting the cursor on either one does not turn it back into markdown for you to retype — you work on the thing itself, and the file goes on holding ordinary Markdown. See *Working With an Image* and *Tables*.

### Code Files
A source file — \`.py\`, \`.c\`, \`.rkt\`, \`.js\`, \`.rs\`, a shell script, JSON, YAML and about sixty others — opens in a **code pane** instead of the note editor, and opens ready to type in.

It is the same window you are used to, with only the text itself different: line numbers down the side, your syntax colours (the **One Dark Darker** and **One Light** palettes from your own editor), **Fira Code with its ligatures**, and no line wrapping — a long line scrolls sideways, as it should.

What the pane gives you:
- **Several cursors.** Hold \`Option\` and click to put a cursor on another line; hold \`Option + Shift\` and drag to select a column. Everything you type then lands at every cursor.
- **Completion** as you type, from the names already in the file and the language's own keywords. \`Enter\` takes the highlighted one, \`Escape\` dismisses the list.
- **Brackets are coloured by how deeply they nest**, six colours before the cycle repeats, so the shape of a nested expression is readable at a glance — and a bracket with nothing to close is underlined in red. **Settings → Colour brackets by depth** turns this off and on, and takes effect in files you already have open. They are also typed in pairs, the partner of the one beside the cursor lights up, and brackets inside strings and comments are left out of the counting.
- **Folding**: the arrow beside a function or a block folds it away; click it again to bring it back.
- \`Tab\` indents and \`Shift + Tab\` outdents, by the width in **Settings → Tab size**. **Settings → Code font size** sets how big code is, separately from your notes.
- \`Cmd + F\` searches the file, \`Cmd + Z\` undoes, and your edits save exactly as a note's do, a second after you stop typing.

\`Cmd + E\` switches the pane to read-only, which is useful when you are reading rather than editing and do not want a stray keystroke in the file.

**Racket** (\`.rkt\`) gets extra care, since it is a teaching language the stock grammar reads poorly: special forms (\`define\`, \`cond\`, \`else\`, \`check-expect\`, \`local\`…) are coloured as keywords, the name at the head of every form is coloured as the function it is, quoted symbols read as values, and the numbers in \`[…]\` answers are numbers.

**The AI agent reads code files too**, and it is told which language it is looking at and where your cursor is. It can edit them with the same rules it edits notes with: changes land in the open pane and \`Cmd + Z\` takes them back.

There is no compiler here, and no way to run the code — this is a notes app that can hold your code beside your notes, not a terminal.

### LaTeX (\`.tex\`) Files
A \`.tex\` file opens **typeset rather than raw**: sections become headings, \`$…$\` and \`align\` blocks are set as maths, \`itemize\` and \`enumerate\` become lists, a \`tabular\` becomes a table, and a \`verbatim\` or \`lstlisting\` block keeps its exact spacing. The preamble sits at the bottom, folded away, since it is instructions to the compiler rather than part of the paper.

Nothing is hidden from you: a command this app does not know is shown as itself, greyed, with whatever it wrapped still readable beside it. This is a reader, not a LaTeX compiler: it does not run packages, number equations or follow \`\\input\`.

\`Cmd + E\` switches to the **source**, exactly as it stands in the file. Markdown's live preview is deliberately switched off there: in a file that has to compile, \`_\` is a subscript and \`$\` opens maths, so the text stays literal and safe to edit.

### Collapsing a Section
In Read Mode, point at a heading — or at the margin just to its left — and a small arrow appears beside it. Click the arrow to collapse everything under that heading, up to the next heading of the same or a higher level: a \`##\` section takes its \`###\` sub-sections with it and ends at the next \`##\` or \`#\`. Click it again to bring the section back.

A collapsed heading keeps its arrow on show, pointing right, and has a small **…** after its title; clicking either one expands the section. Each sub-section remembers its own state, so a \`###\` you collapsed is still collapsed when you expand the \`##\` around it.

Collapsing only changes what you see — the file itself is never touched. A note remembers which of its sections are collapsed when you switch tabs or reload. Edit Mode always shows the whole note, and switching back to Read Mode collapses the same sections again; a heading you delete while editing is simply forgotten. Jumping to a search result inside a collapsed section opens it, and so does a match found with \`Cmd + F\` / \`Ctrl + F\`.

Only \`#\`-style headings at the top level of a note collapse — not ones inside a quote or a list — and a heading with nothing under it has no arrow.

### Finding Text in a Note
Press \`Cmd + F\` / \`Ctrl + F\` with a note or text file in front of you — in Read Mode or Edit Mode — and a find box opens in the top-right corner of that note, staying there as you scroll. It searches the whole note, not just the part on screen, including sections you have collapsed: a match inside one opens it.
- Start typing and it jumps to the first match from where you are, every match is highlighted, and the box counts them — **3 of 15**.
- \`Enter\` (or **›**) goes to the next match and \`Shift + Enter\` (or **‹**) to the one before, wrapping round at the ends. \`Cmd + G\` / \`Ctrl + G\` and \`Shift + Cmd + G\` / \`Shift + Ctrl + G\` do the same, whether you are in the box or back in the note. \`Alt + Enter\` selects every match at once.
- The three toggles inside the field narrow what counts: **Aa** matches case, **ab** matches whole words only, and \`.*\` treats what you type as a regular expression.
- **Replace** is only there in Edit Mode, because Read Mode never changes the note: open it with the arrow at the box's left. \`Enter\` in the Replace field (or **Replace**) replaces the current match and moves on; \`Cmd + Enter\` / \`Ctrl + Enter\` (or **All**) replaces every match. Switch modes with the box open and Replace appears or disappears; what you typed is kept.
- Right-click the field for Cut, Copy, Paste and Select all.
- \`Escape\` closes the box while you are in it, and so does its **×**. The keys then work on the note again: in Read Mode \`Space\` and \`Page Down\` scroll it, and in Edit Mode you are back typing where you were. Each press closes one thing: with the **Linked mentions** list open too, the first \`Escape\` closes the box and a second closes the list.

With more than one pane open, it searches the pane you last clicked in. While you are typing in the sidebar's search box or a rename field, \`Cmd + F\` is the browser's; PDF Original opens the PDF's own find bar, which searches every page, while PDF Text searches its extracted text (see *PDFs*).

### Room Below the Last Line
A note scrolls on past its last line by about half the height of its pane, so the end of what you are reading or writing can sit in the middle of the screen instead of against the bottom edge. A note shorter than that doesn't scroll at all. In Edit Mode, clicking in that space puts the cursor at the end of the note.

### Auto-Save
You do not need to manually save your work. The editor automatically saves your changes to your local hard drive 1 second after you stop typing. You can also manually trigger a save using \`Cmd + S\` or \`Ctrl + S\`. If you reload or close the window while a change is still waiting to be saved, the browser asks whether you want to leave, in its own words; choose to stay and the save finishes as usual. Switching away from the window also saves straight away, as far as the browser lets it: that is a best effort, not a guarantee against a crash.

If a save fails — the folder became read-only, the disk is full, another program holds the file — a notice at the bottom right says which file was not saved and why, and the status bar reads **Not saved**. It never takes the keyboard, so you can keep typing: your text stays in the tab, the next change tries again, and the notice goes away by itself once a save succeeds. Close it with **×** if you have read it; it stays closed for that file until the file saves again.

### When Files Change Outside the App
Your notes are ordinary files, so other programs can change them too — a \`git pull\` in the terminal, a formatter, a sync service like iCloud or Dropbox, another editor, or this app open in a second browser tab. The editor notices, and never saves over a change it has not seen:
- **A note you have open updates by itself** when its file changes and you have nothing unsaved in it. Your cursor and scroll position stay where they were, and \`Cmd + Z\` / \`Ctrl + Z\` steps back to the text you had before. Drawings, notebooks and PDFs reload the same way.
- **If you were in the middle of editing it**, neither version wins silently. A bar appears at the top of the note — "*changed on disk while you had unsaved edits*" — with two buttons. **Reload** shows the version on disk and keeps yours beside it as \`name (conflict).md\`; **Keep mine** saves your version and keeps the one from disk beside it as \`name (conflict).md\`. (If that name is taken, the copy is called \`name (conflict 2).md\`, and so on.) Until you choose, the note is not saved, but you can keep reading and editing it; its tab carries a warning sign meanwhile, so a note waiting on you is easy to spot behind other tabs.
- **Drawings, notebooks and PDFs get the same bar.** **Keep mine** writes your version — for a PDF, its pages and every annotation — and keeps the file the other program wrote beside it as a \`(conflict)\` copy; **Reload** shows the file on disk and keeps yours beside it the same way. While the bar is up, a drawing or an annotated page cannot be changed; the board says so. The bar can also come up with nothing unsaved — when a save of yours, or a turn of a PDF's pages, met the other program's write — and then says the tab still shows the version from before: **Keep mine** puts that version back. If the app no longer holds it, the bar says so and offers only **Reload**. While the bar is up, a PDF stays in the view it is in — \`Cmd + E\` does nothing until you choose — and if the file changes as you leave Annotate, Annotate stays open with your ink and the bar comes up instead.
- **Even when a change could not be noticed as it happened**, every save first checks that the file is still the one you opened. If it is not, nothing is written and the same bar appears. A change that only touched the file's date (\`touch\`, or a checkout that wrote the very same text) is not counted as a change.
- **After an interruption**, if this browser has recovered changes for the file you open, a bar offers **Recover** or **Discard**. Changes for a missing or changed file, and older changes from another window, appear under **Recovered changes available as copies**; choose **Save a copy** to keep them without replacing the file. Native drawing and notebook copies also restore the media bytes retained in their recovery record; an existing, different picture is kept and the recovered copy uses a free filename. These recovery records are stored in this browser, not in the vault, and can be lost if browser storage is cleared.
- **If the file is deleted**, the bar says so, and typing does not quietly bring the file back: **Save again** writes your note back where it was (folders included), and **Close** closes the tab — asking first if it holds edits that exist nowhere else. Closing a note whose file changed or vanished in any other way (the × on its tab, say) keeps your unsaved edits beside it as a \`(conflict)\` copy rather than dropping them.
- **Changing a document’s kind by renaming its extension** first preserves pending source edits. Edits made during the move are kept in a \`(conflict)\` copy with the original extension before the destination is reopened. A failed preservation keeps the original editor open.
- **If the file is renamed or moved**, its tab follows it to the new name, and a renamed folder keeps its icon, colour, custom order and whether it was expanded — when your system reports the change as a rename. A sync service that copies and then deletes, or a folder renamed on Windows, looks like a new folder: open notes inside are followed when their contents match, but the folder's look starts fresh. When the app cannot be sure where a file went, the tab shows it as deleted rather than guess.
- **The file tree updates by itself** as files and folders are created, deleted, moved or renamed outside the app, and so do search, the graph and the *Modified* sort. A \`.git\` folder is never shown.

### Scroll Persistence
The application remembers where you were reading in every note: the line at the top of the editor, and how far into it you had scrolled. Switch to another tab and back, close the note and open it again, or reload the app, and that line comes back to the top of the editor — whether you were in Reading mode or editing when you left. If that line is now inside a section you have collapsed, the note opens at that section's heading instead, and the section stays collapsed; if Reading mode draws it as part of a table or maths block, the note opens at the top of that block.

### Right-click
Right-clicking in a note, or anywhere in the file tree, opens the application's own menu instead of the browser's. Escape closes it, and so does clicking somewhere else or scrolling.

**In a note** the menu offers **Cut**, **Copy**, **Paste**, **Select all** and **Insert table…**. A row that cannot do anything just now stays on the menu and says why when you hover it — Cut with nothing selected, or anything that writes while you are in Read Mode (\`Cmd + E\` / \`Ctrl + E\` switches out of it). Right-clicking *outside* your selection moves the cursor there first, so **Insert table…** lands where you aimed; right-clicking *inside* a selection leaves it alone, so **Copy** means what it looks like.

**Paste** is the one row that can refuse. Browsers guard reading the clipboard, and by the time you click a menu row the right-click that opened it no longer counts as your permission — so the browser may say no. The application tells you when that happens: \`Cmd + V\` / \`Ctrl + V\` always works and needs no permission at all. Inside a table cell, \`Cmd + X\` / \`Cmd + C\` / \`Cmd + V\` are the browser's own and never refuse either.

**In a table cell** the menu is the table's own — rows, columns, and the cell's own clipboard. See *Tables*.

**In the file tree**:
- On a **file**: *Rename*, and *Move to Trash*. A drawing or notebook from an older version of the app also offers *Make an editable copy* (see *Drawings*).
- On a **folder**: *New note*, *New folder*, *Open as Vault*, *Rename*, and *Move to Trash*. *Open as Vault* narrows the app down to that folder — see *Switching Vaults*. New note and New folder open a small input row inside that folder, and open the folder so you can see what lands in it.
- On the **empty space** below the tree: *New note* and *New folder*, at the vault root.
- *Move to Trash* asks first and names where the item is going, exactly as the row's own trash button does.
- A row you are in the middle of renaming keeps the browser's menu, because what you want there is its Paste.

A **drawing** keeps its canvas controls. PDFs use their in-app reader and annotation controls.

---

## 5. Drawings, Notebooks, and PDFs

Three kinds of file open on a canvas instead of in the text editor: **drawings**, **notebooks** and **PDFs** you write on. All three use the same **board** — the same tools, menus and shortcuts, described first below — and are saved a second after you stop. A board is editable whenever its file can be written; otherwise it opens read-only with a notice that says why.

Make a drawing or a notebook with the **pencil** button at the top of the sidebar (**New drawing or notebook**), then **New Drawing** or **New Notebook**, and type its name.

A board you open or create from the file tree takes the keyboard straight away, so its tool keys work at once; so does clicking any button on its tool bar.

### The tool bar
The bar at the bottom centre holds **Select** (\`V\`), **Hand** (\`H\`), **Draw** (\`D\`, also \`B\` or \`X\`), **Eraser** (\`E\`), **Arrow** (\`A\`), **Text** (\`T\`), **Note** (\`N\`, a sticky note), **Media** (a picture or video from your computer, \`Cmd/Ctrl + U\`) and **Rectangle** (\`R\`). The chevron at its end opens **More tools**: the other nineteen figures (ellipse \`O\`, triangle, diamond, hexagon, oval, rhombus, star, cloud, heart, x box, check box, four block arrows, pentagon, octagon, trapezoid and rhombus 2), **Line** (\`L\`), **Highlight** (\`Shift + D\`), **Laser** (\`K\`) and **Frame** (\`F\`). While one of those is the active tool, the chevron shows it filled in blue. The bar's last figure slot holds the figure you drew with last, at first **Rectangle**: choose another figure from More tools and it takes that place, and \`G\` draws with it again. Hover any button for its name and key. On a touchscreen a tap on a bar tool chooses it at once, and a finger dragged off the bar creates that tool's shape where the finger lets go. In a narrow pane, the tools that do not fit on the bar move to the front of the chevron's list, the header's Undo, Redo, Delete and Duplicate move into its **Actions** grid, and the zoom box sits just above the bar.

While a board is still drawing itself for the first time (it says **Loading drawing…** or **Loading notebook…**), a press on it is not taken yet and the pointer over it shows the busy cursor: a stroke begun then is not drawn at all, so start once the board appears. The tool bar, styles, menus and keyboard shortcuts work meanwhile.

**Tool lock** (\`Q\`, Menu → Preferences, or the padlock that appears above the bar when a shape, text, note, frame, arrow, line or media tool is chosen) keeps the tool you picked after each use. A shape, arrow, line or frame you have let go of always lands, however quickly you start the next one, press a key or pick another tool; \`Escape\` before you let go still cancels it, and \`Cmd/Ctrl + Z\` right after takes back the last one. Press \`1\` to \`9\` to choose the tool in that position on the bar, left to right; a tool that a narrow window has moved into More tools has no number. Drag a tool from the bar onto the board to make that shape where you let go; a plain click only chooses the tool. \`Escape\` returns the chosen tool to Select, and closes More tools or the Actions grid.

### Moving around
- **Pan:** scroll or swipe, drag with the Hand tool, hold \`Space\` and drag, or drag with the right mouse button or with a pen's barrel button held. The arrow keys pan when nothing is selected (\`Shift\` for bigger steps). Holding \`Space\` and pressing an arrow key moves the view by one screen, gliding for about a third of a second (at once with **Reduce motion**).
- **Zoom:** pinch, or scroll as your **Input device** setting says (below). \`Cmd/Ctrl + =\` and \`Cmd/Ctrl + -\` zoom in and out, as \`=\` and \`-\` do, and \`Shift\` with either zooms around the pointer. \`Shift + 0\` goes back to 100%, \`Shift + 1\` fits everything on screen and \`Shift + 2\` fits the selection. The **zoom box** at the bottom right shows the zoom; click it for the zoom menu (in, out, 100%, fit and selection), which stays open while you step the zoom. Double-click the percentage for 100%.
- **Zoom to an area:** hold \`Z\` and drag a rectangle to zoom to fit it. Hold \`Z\` and click to zoom in one step, or \`Alt\`-click to zoom out one step. With \`Alt\` held while you drag the box, the new zoom is at most half the current one, so the box only zooms out.
- **Quick overview:** while holding \`Z\`, press \`Shift\`. The board zooms out about the pointer, so what is under it stays under it, until the view and everything on the sheet both fit, and a rectangle follows the pointer; let go of \`Z\` or \`Shift\` to land there, or press \`Escape\` to go back where you were. The pointer is an arrow while the overview is up.
- If you wander far from everything, a **Back to content** button appears at the top left after a moment and glides you back to your selection, or to the sheet.
- Menu → Preferences → **Input device** sets what the wheel does. With **Default (trackpad)** or **Trackpad**, which behave the same, a scroll pans, and \`Ctrl\` / \`Cmd\` with a scroll zooms, as a pinch does. With **Mouse**, a turn of the wheel zooms and \`Ctrl\` / \`Cmd\` with a scroll pans; **Invert mouse zoom** reverses the zoom direction. One turn changes the zoom by at most 10%. **Edge scrolling** (on by default) pans when you drag something to the edge of the board.
- **Two fingers** pan, and pinch to zoom. Spreading or closing them by more than 24 px starts a zoom; a two-finger pan turns into a zoom only after the spacing changes by 64 px, so a pan does not zoom by accident. On touch, double-tap and hold, then drag up to zoom out or down to zoom in; 200 px doubles or halves the zoom, and a double tap without a drag zooms in one step.
- **Pen mode:** when a pen touches a touchscreen, the board switches to pen mode. The pen draws; the mouse and a finger can no longer draw or edit, though two-finger pan and pinch still work. **Exit pen mode** at the top left leaves it.
- The arrow beside the zoom percentage opens the **minimap**, which shows the whole drawing with your view as a box. Press outside the box to glide there, or drag inside it to move the view. Selected shapes show in the map, and it stays open or closed between visits.

### Drawing
- **Draw** follows your pen, mouse or finger, and however fast or slowly you draw the line comes out as a smooth curve through the path your hand took, without the pointer's pixel steps, and a loop that ends where it began closes smoothly; only a sharp turn stays a corner. Hold \`Shift\` while drawing to make the next part a straight line, whose direction snaps to 15° steps; hold \`Cmd/Ctrl\` as well to draw it without the snap. Press \`Shift\` and click with Draw to continue your last stroke with a straight line from its end.
- **Highlight** draws a broad see-through stroke. **Laser** draws a trail that fades by itself and is never saved — for pointing while you share your screen.
- **Eraser** removes whole items. The ring round the pointer is its reach (a finger reaches a little further): whatever it touches leaves the board at once, while you are still dragging, and a tap removes what is under it. A shape with no fill goes when you touch its outline or its label, not its empty inside, so you can rub out what is written in a box and keep the box; touching one item of a group removes the group, and a locked item stays. A frame goes, with everything in it, when you touch its border or its name, not its empty inside, so what sits in a frame can be rubbed out item by item; of an item its frame cuts off, only the part that shows can be touched. A short trail as wide as the ring follows the pointer. One sweep is one step: \`Cmd/Ctrl + Z\` brings back everything it removed, and \`Escape\` before you let go does the same and leaves nothing to undo. Scrolling or zooming in the middle of a sweep, or a palm resting on the screen while the pen erases, does not end it. With the Eraser chosen, hold \`Cmd/Ctrl\` to remove only the item on top; what lay under it is left alone for the rest of that sweep. Every sweep counts, however quickly you start the next one or switch tools, also right after an arrow-key nudge. Hold \`Cmd/Ctrl\` over Draw or Highlight to erase the whole items under the pointer until you let go, and then the drawing tool comes back — also when you let go somewhere else, such as after \`Cmd + E\` from Annotate to Original. With a drawing tool chosen, a right-click first switches to Select, so the menu acts on what is under the pointer.
- **Figures** and **Line**: drag to draw. **Arrow**: see *Arrows* below. While you drag a line's end or bend, hold \`Shift\` to hold it to 15° steps from its neighbouring point. On a touchscreen, a shape started with a tap is dropped if you keep your finger still for half a second.
- **Text**: click to start typing, or press and hold for a moment, then drag sideways to make text that wraps at the width you drag. Dragging **Text** off the bar shows a mark that follows the pointer; where you let go, a text reading **Text** is created and selected, so typing replaces it. **Note**: drag to make a note that follows the pointer and lands where you let go; a click centres one on the pointer, or puts it in a free space beside another note when you click within 10 px of that space. To change the words of a selected text or note, press \`Enter\` or double-click it; \`Escape\` finishes and gives the keyboard back to the board. Double-clicking a text selects all of its words, and clicking the only selected text places the caret where you click. While you edit, double-click a word to select it and triple-click to select its paragraph, with the mouse or with two or three taps of a pen; drag on from that click, or \`Shift\`-click afterwards, to extend the selection by whole words or paragraphs. A note's words always stay readable on its colour: where the colour you chose would be too faint, they turn black or white, whichever reads better. Pressing another note's or shape's text while one is open finishes the first and opens the one you pressed. If the keyboard has left the text you are editing (you clicked the style panel, say), dragging that shape moves it.
- **Frame**: drag to draw a named frame. It clips what sits inside it and takes in anything fully inside the box; \`Cmd/Ctrl + Alt + G\` frames the selection, or removes the frames when only frames are selected; \`Cmd/Ctrl + Alt + Shift + G\` removes the selected frames either way (their contents stay put). **Fit to content** (Menu → Edit) shrinks or grows a frame around what it holds. A click with the Frame tool makes an empty frame of the default size where you click; only a frame you drag out takes in the shapes it fully encloses. Double-click the left or right edge of a selected frame to fit its width to what it holds, the top or bottom edge to fit its height, or a corner to fit both; the fit leaves a margin.

**While you edit text**, \`Cmd/Ctrl + B\` (bold), \`Cmd/Ctrl + I\` (italic), \`U\` (underline), \`Cmd/Ctrl + Shift + S\` (strikethrough), \`Cmd/Ctrl + Shift + H\` (highlight), \`Cmd/Ctrl + E\` (inline code), \`Cmd/Ctrl + Shift + 8\` / \`7\` (bulleted / numbered list) and \`Cmd/Ctrl + Alt + 1\` to \`6\` for headings (\`0\` for plain text). \`Cmd/Ctrl + Shift + K\` edits the link on the selected text, and \`Cmd/Ctrl + K\` finishes the edit and opens the command palette. The formatting bar above a selection shows Bold, Italic, Inline code, Link, Bulleted list and Highlight; a format that is on is highlighted. Misspelt words are underlined; right-click one for suggestions or **Add to dictionary**. The words you add are listed, and can be removed, under **Settings → Editing → Board dictionary**.

**Typing** turns \`--\` into an em dash (—), \`...\` into an ellipsis (…), \`(c)\`, \`(r)\` and \`(tm)\` into © ® ™, \`1/2\`, \`1/4\` and \`3/4\` into ½ ¼ ¾ (at the start of a word), \`+/-\` into ±, \`!=\` into ≠, \`<<\` and \`>>\` into « and », and \`<-\` and \`->\` into ← and →. Quotes and apostrophes curl as you type; inside code, or while a backtick is still open, they are typed as written. With text selected, typing \`(\`, \`[\`, \`{\`, \`<\`, \`"\` or \`'\` wraps the selection in that pair. **Tab** types a tab character in a text box, and indents or outdents a list item; in a note it moves to the neighbouring note in that direction when there is one, and otherwise types a tab. Pasted text wraps at 90% of the view width and stays auto-sized when it fits.

### The style panel
The style panel sits at the top right of a drawing, a notebook or an annotated PDF, and shows the styles that apply to what you are doing. With something selected it shows the rows those items have: colour, opacity, fill, dash, size, pen width (for ink, text and notes), font, alignment, shape, arrow kind, arrowheads or line type. With nothing selected it sets the style of the next shape you make. Pick one of twelve colours. Where the items in a selection differ, the row says **Mixed** and nothing is picked until you choose. Press a colour or option and move across others to apply each one as you pass it; releasing keeps the last. The whole press is one undo step. The width slider is continuous rather than a set of sizes, from a normal writing width down to a hairline: double-click it to come back to the default, and the arrow keys and Page Up / Page Down move it, a held key being one undo step. Figures, arrows and lines have no width slider; their **Size** row sets the outline width and the text of their labels.

The chevron in the panel's header folds it to its title and the colour in use; the chevron opens it again. **Cmd/Ctrl + Enter** moves the keyboard into the panel, and **Escape** returns it to the board; **Cmd/Ctrl + Z** still undoes from there. Below about 640 px of pane width the panel becomes a palette button in the bottom bar, tinted with the colour in use, which opens the same controls. **Every file keeps its own pen.** A notebook you annotate in fine red stays fine and red; the PDF you were marking up in thick blue is still thick and blue when you come back to it. A brand new file starts at the width you were last using.

Style keys for the selection: \`Alt + F\` fills a figure, \`Alt + Shift + F\` gives it a lined fill, \`Alt + T\` makes it white, and \`Shift + Q\` copies the style of what is under the pointer.

### Arrows
**Arrows** attach to shapes. Drag an end onto a shape and rest there for about a third of a second, or move onto it slowly, and it attaches to the exact point under the pointer; move onto it quickly and it attaches to the shape's centre. Hold \`Alt\` to attach exactly, with no marker, or hold \`Cmd/Ctrl\` to leave the end unattached. While you drag, the shape an end will attach to is outlined; with the Arrow tool, hovering a shape shows a ring at its centre, and after a moment a cross shows the exact point. While you drag an elbow arrow's end, its shape shows four dots at the middle of each edge, and a circle where the end will land on an edge. An elbow arrow that ends on a shape's edge reaches it straight on from outside, going around the shape if it has to, and never runs through the shape to get there. Shift holds a free end to 15° steps, and an unattached end follows the grid when grid mode is on, and so does an arrow's start point. An arrow attached at both ends lives in the frame or group its two shapes share, or on the sheet, and it moves into or out of a frame with its shapes. A drag shorter than 10 units makes no arrow, and an arc keeps its curve when one end is released from its shape. An attached end stays attached when its shape moves, and when you change its shape the end that the new outline leaves outside moves to the nearest point of that outline. Dragging a selected arrow moves it free of its shapes, unless those shapes move with it. Click an arrow's label, without dragging, to edit its text. Dragging the middle handle bends the arrow, and near the straight line it straightens it; an elbow's middle handle snaps to the middle of its range and to the parallel segments of other elbows that share a shape. Double-click an arrow's end to switch its arrowhead on or off. \`Cmd/Ctrl\` with a drag on an arrow's end or label draws a selection box instead of moving it. A selected arrow shows the stubs where it is bound.

### Selecting and arranging
- Click to select; \`Shift\`-click or \`Cmd/Ctrl\`-click adds or removes. Drag a box on empty space to select what it reaches: the selection follows the box as you drag, and \`Escape\` puts back the selection you had. Inside the frame of a selection even empty space moves the selection when you drag it; to draw a new box there, press \`Escape\` or click outside the frame first, or hold \`Shift\` to box more into the selection. With **Select when wrapped** on (Menu → Preferences) the box selects only what it fully encloses; holding \`Cmd/Ctrl\` during the drag reverses that. You can press \`Delete\` the moment you let go: it removes what the box selected. Hold \`Alt\` and drag on empty space to draw a free path that selects what it crosses, as you draw it. \`Cmd/Ctrl + A\` selects everything on the sheet, and \`Tab\` / \`Shift + Tab\` step through items. Hover a shape to see its outline; a right-click selects the shape under the pointer before its menu opens. Hold \`Cmd/Ctrl\` and drag from a shape to draw a selection box instead of moving it. Shift, Cmd or Ctrl with a double-click does nothing; a plain double-click on empty board starts text there. A second click that you drag is that drag — a box, a move or a stroke — and never a double-click, so a box made with a trackpad's tap-then-drag keeps what it selected. Selection handles draw larger when the board was last used with a finger or a pen.
- Drag to move (\`Shift\` keeps the move straight), drag a corner or edge to resize (\`Shift\` keeps the proportions, \`Alt\` resizes from the centre), drag the rotate handle to turn (a turn lands on whole degrees when you let go, and on a right angle on touch; \`Shift\` snaps it to 15° steps as you turn). \`Alt\`-drag moves a copy and leaves the original.
- Arrow keys nudge the selection (\`Shift\` for farther). \`Cmd/Ctrl + D\` duplicates (each further copy goes the same distance on again, or repeats the offset of your last Alt-drag clone), \`Delete\` or \`Backspace\` removes.
- \`Cmd/Ctrl + G\` groups two or more items, or ungroups a single group; \`Cmd/Ctrl + Shift + G\` ungroups. Double-click inside a selected group, or press \`Enter\`, to select one thing in it; \`Escape\` steps back out of the group before it clears the selection. \`Shift + L\` locks the selection so it can't be moved by accident (right-click a locked item to unlock it; Menu → Edit → **Unlock all** unlocks everything).
- \`[\` / \`]\` send to the back / bring to the front, and \`Alt + [\` / \`Alt + ]\` one step. \`Shift + H\` and \`Shift + V\` flip; \`Shift + .\` and \`Shift + ,\` rotate (with \`Alt\` in finer steps). \`Alt\` with \`A\`, \`H\`, \`D\`, \`W\`, \`V\` or \`S\` aligns left, centre, right, top, middle or bottom.
- \`Shift + F\` **flattens** the selection into a single picture.

### Snapping and the grid
Dragging a shape snaps it to other shapes: its edges and centre line up with theirs, and an evenly spaced gap shows when a shape fits between two others. Each point that lines up is marked with a cross. Hold \`Cmd/Ctrl\` while you drag to snap; if **Always snap** is on in Preferences, holding it drags without snapping instead. Pressing or releasing \`Cmd/Ctrl\` during a drag switches the snap at once. A shape or a line end does not snap while the pointer moves fast, so move more slowly to snap. While the grid is shown, a plain drag snaps to it, a snap to another shape wins over the grid, and holding \`Cmd/Ctrl\` drags off the grid. A line's end or bend snaps to the corners and centres of other shapes and to the line's own other points within 8 px, and to the nearest point of another shape's outline when no corner or centre is in reach. Resizing snaps to other shapes only while the shape is unturned or turned by a right angle. A note dragged close to a free space beside another note snaps into it within 10 px. A pasted or dropped group's top-left corner lands on the grid when the grid is shown, and every figure, frame and note you make lands on it too, and an arrow's start point does. The arrow keys nudge a selection 1 px (\`Shift\`: 10 px), or one grid step (\`Shift\`: five) when the grid is shown.

### The board's menus
The strip in the top-left corner holds the **Menu** (☰), the **sheet** drop-down, **Undo**, **Redo**, **Delete**, **Duplicate** and **Actions** (⋮). Undo, Redo, Delete and Duplicate are dimmed when they cannot act, and say why when you hover them.

- **Menu** has **Edit** (undo, cut, copy, paste, duplicate, delete, select all, **Copy as**, group, flatten, frames, locking, and **Convert to bookmark / embed** for links), **View** (the zoom commands and **Toggle minimap**), **Export**, **Insert embed…** (\`Cmd/Ctrl + I\`), **Upload media…** (\`Cmd/Ctrl + U\`), **Preferences**, **Language** (the board's own buttons and menus come in 49 languages) and **Keyboard shortcuts…** (\`Cmd/Ctrl + Alt + /\`), which lists every key in three columns. If keyboard shortcuts are turned off, the dialog says so at its top, and Delete, \`Cmd/Ctrl + Enter\`, \`Cmd/Ctrl + Shift + Enter\` and \`Alt + R\` still work.
- **Actions** opens a grid of buttons for the selection: align, stretch, distribute and stack; send to back, backward, forward and to front; rotate; **Edit link…**; and **Group**, which becomes **Ungroup** when the selection is a group.
- **Command palette…** (in the Menu, or \`Cmd/Ctrl + K\`, which also finishes a text edit first) lists every command, tool and style and searches them as you type. Arrows or Tab move, Enter runs, → opens a submenu, and ← (or Backspace on an empty search) goes back; Escape backs out or closes. Styles include an **Opacity** submenu from 10% to 100%. On a drawing you can edit, a command that cannot run now stays listed and says why.
- **Right-click** the board for the same commands where you clicked: Cut, Copy, Paste, Duplicate, Delete, Copy as and Select all, plus, with something selected, **Edit**, **Arrange**, **Reorder**, **Move to page** and **Export as**. **Arrange** holds the flips, the alignments, distribute, stretch, pack and **Stack**, which needs at least three shapes and lines them up in order, left to right or top to bottom. **Move to page** can send the selection to a **New sheet**. Flipping a text keeps its letters readable. A row that cannot run now stays on the menu and says why — a locked picture, a read-only board, nothing selected. \`Cmd/Ctrl + Shift + Enter\` opens the same menu from the keyboard.
- **Preferences**: Always snap, Tool lock, Show grid (\`Cmd/Ctrl + '\`), Select when wrapped, Focus mode (\`Cmd/Ctrl + .\`, hides the board's controls; a dot in the bottom-right corner brings them back), Edge scrolling, Dynamic size, Paste at cursor, **Accessibility** (reduce motion, turn the board's keyboard shortcuts off, enhanced accessibility), **Input device** (see *Moving around*), a drawing's **Theme** (dark, light or system; \`Cmd/Ctrl + /\` toggles it), and Debug mode.

**Sheets.** A board can hold several sheets — separate canvases in one file. The sheet drop-down lists them: click one to go there, **New sheet** adds one, and the **⋯** beside a sheet renames, duplicates, moves or deletes it. Double-click the current sheet's name, or press \`Enter\` on it, to rename; drag a sheet's row to reorder, and drag the grip under the list to set its height (double-click the grip for automatic height). With the board focused, \`Alt + ←\` or \`↑\` goes to the previous sheet and \`Alt + →\` or \`↓\` to the next; on the last sheet, a forward step adds a new sheet once that sheet has content. A notebook's or a PDF's sheets all share its paper or pages (a PDF calls them **Annotation sheets**).

### Pictures, videos, links and embeds
Drop or paste a picture or video onto a board, or use **Media** / \`Cmd/Ctrl + U\`. Right-click a selected picture for **Replace media…** (the new one keeps the old one's centre and longer side; on a PDF page it is embedded in that PDF), **Crop image**, **Crop to aspect ratio** (original, square, circle, 4:3, 3:4 or 16:9), **Invert image colours**, **Download original** and **Alternative text…**. A video adds **Play** / **Pause**. Pictures copied from a drawing or notebook — an editable copy of an older one included — paste onto a PDF's pages, where they are kept inside the PDF, and copy back out of it the same way. A picture carrying details this version of the app cannot read is not pasted where it would be stored under another name; the board says so, and it pastes into a drawing or notebook in the folder it came from.

**A picture whose file is missing.** A board's pictures are files in the \`.Assets\` folder beside it. If one is not there — the board was moved or copied without that folder, a sync service has not downloaded it yet, or the file was deleted — the picture shows as a grey box and a notice says what it was called and the exact file name it needs in that folder (a long name of letters and digits, which is how boards store their pictures). Everything else still works: you can draw, move, copy, paste and undo, the board saves, crash recovery keeps your changes, and exports show the grey box where the picture sits; only **Download original** needs the file itself. The board keeps its reference to the picture exactly as it was, so once that file is back in the \`.Assets\` folder under that name, reopen the board and the picture is there again.

**Cropping** happens on the canvas. Double-click a picture, press \`Enter\` with it selected, or choose **Crop image**: the whole original stays visible, faded outside the kept window. Drag an edge or corner to crop (\`Shift\` keeps the proportions, \`Alt\` resizes from the centre), and drag inside to move the picture within its frame; the arrow keys nudge it, and \`Shift\` with them moves it farther. \`Enter\` applies the crop, \`Escape\` cancels it, and a click outside applies it. Hold \`Cmd/Ctrl\` and drag a selected picture's handle to start the crop from that edge in one motion. Double-click a crop edge to give that side back to the whole picture. The bar's aspect menu, zoom slider and **Fit** keep the crop open, and **Apply** hands the keyboard back to the board. A selected picture's toolbar has **Replace**, **Crop**, **Download original** and **ALT** buttons. The crop bar and the picture's toolbar sit above the picture, or below it when there is no room above, and move aside rather than cover the Styles panel, the board's other controls or the edge of the pane.

A pasted web address becomes a **link card** showing its address. **Fetch link preview** (on the card, or in its right-click menu) contacts the link's site only when you ask, and keeps the title, description, picture and icon the page declares in the board's pictures folder. **Open link** (or \`Cmd/Ctrl\`-click on the card) opens the address in a new tab. A pasted link instead fills the one selected figure, note, picture, card or embed that is unlocked, rather than making a new card.

**Embeds.** **Menu → Insert embed** places a web embed (a video link, say) on the board as an inert poster. Nothing loads until you ask: press **Load** on the card (or right-click → **Load embed**); **Stop** on the card, or **Unload embed**, puts the card back. A loaded embed plays in place. If something drawn on top of it is see-through, the board keeps showing its true picture and the embed opens in a panel of its own above the board instead, with an **Unload** button; \`Escape\` closes it too. Closing the tab or switching documents always unloads it.

### Inverting a Picture You Brought Over
Screenshots taken out of a dark-themed app land on a notebook page or a whiteboard as a black rectangle. Select the picture and press \`I\` to invert it, so it sits on the page like everything else drawn there, and press \`I\` again to put it back. It applies to every picture you have selected, undoes with \`Cmd + Z\`, is saved with the file, and comes out inverted in a notebook's exported PDF too. Only that picture changes; the image file in your vault is untouched.

### Copying, exporting and printing
\`Cmd/Ctrl + X\`, \`C\` and \`V\` cut, copy and paste the selection. \`Cmd/Ctrl + Shift + V\` pastes plain text, \`Cmd/Ctrl + Alt + V\` pastes at the cursor, and \`Cmd/Ctrl + Shift + Alt + V\` pastes plain text at the cursor. A plain paste goes back where it was copied from when that is on screen, and otherwise into the middle of the view. A paste at the cursor lands in the frame under the pointer, if there is one. A paste always lands, however soon you carry on: a stroke, a box, a drag, a click, a scroll or a tab switch made while it is still being prepared goes ahead as usual, and the paste lands as soon as that is done. It selects what it pasted, unless you chose something else in the meantime, which then stays selected. A key you press after pasting acts after the paste has landed, so \`Cmd/Ctrl + Z\` takes the paste back and Delete or Escape act on what it selected. If a paste cannot land — the page was changed or the board became read-only first — the board says so. **Copy as → PNG / SVG** copies a picture of the selection (or the whole sheet when nothing is selected), drawn from the artwork rather than a screenshot of the controls; tick **Transparent** for no background. SVG is copied as text. \`Cmd/Ctrl + Shift + C\` copies the selection as PNG.

**Menu → Export** saves **PNG**, **SVG**, **PDF** or **JSON**, named after the board without its own extension (\`Plan.drawing\` downloads as \`Plan.pdf\`; your browser numbers it if that name is taken in your downloads); **Print…** (\`Cmd + P\` / \`Ctrl + P\`) asks first whether to print the selection or the whole sheet: PDF puts a drawing's sheet on one page and a notebook or PDF board on all its pages, and JSON is the board's own records, with pictures referenced by hash rather than bundled. A selection's **Export as** offers PNG, SVG and JSON of just those items. **Print** (\`Cmd/Ctrl + P\` with the board focused) prints the open board the same way. With something selected, Print asks first: **Selection** prints just those items, **Sheet** prints the whole sheet.

Navigation, selection, copying and exporting never edit the file; only drawing and editing do.

### Saving, reopening and the agent
Every change is saved to the file a second after you stop; \`Cmd/Ctrl + Z\` undoes and \`Cmd/Ctrl + Shift + Z\` redoes. Drawings and notebooks **reopen where you left them** — the same spot on a drawing, the same page and zoom in a notebook — just as a PDF does, whether you switch tabs, close the file or reload the app. A drawing you open here for the first time shows the view saved in the file, if it has one (an older version's drawing, and a copy made of it, open where it was last viewed); otherwise it frames everything on the page with a margin, never zoomed in past 100 %.

While a drawing or notebook from an older version of the app opens, its pane says **Opening drawing…** (or notebook); several open one after another, the one on screen first, and the others say they are waiting. If a drawing or notebook cannot open — its file did not arrive in time, as can happen with a file a cloud folder has not downloaded yet, or a part of the app could not start — the pane says why, with **Try again**. One larger than 256 MB cannot be opened, and its pane says so.

A drawing or notebook this version cannot read safely — an unreadable file, one written in a newer format, or one that is not the kind its name says — **opens read-only**: neither drawing on it nor Save can overwrite the original file. An empty file is still a valid new board.

The agent's **canvas tools** work on the document rather than its view: they can change a drawing or notebook while its pane is hidden, each batch is one undo step, and a disk conflict or a read-only file still refuses them.

For drawing without a pointer, the **Use keyboard drawing cursor** button gives the board a cursor you move with the arrow keys and press and lift with \`Enter\`. Holding \`,\` presses the pointer at that cursor, and releasing it lifts the press. \`Alt + R\` repeats the board's last announcement for a screen reader. The skip link **Move focus to canvas** selects the first object in reading order and puts the keyboard on the canvas. On a read-only board it only moves the focus: choosing an object from the board's object list selects it, and a live announcement says which one.

### When the graphics card cannot be used
Drawings, notebooks and PDFs are drawn with your computer's graphics card (WebGL2) whenever the browser offers it, and otherwise with the browser's ordinary drawing, which shows exactly the same thing but can be slower on large documents. When a document has no usable graphics card — graphics acceleration switched off in Chrome, software-only graphics, an unsupported card, or repeated graphics errors on that document — a notice says so once, with **Dismiss**: on a board in a box just above the tool bar, on a PDF at the bottom left. A board's other notices, such as a picture that could not be shown, appear in the same box with it, newest last, each with its own **Dismiss**; a new notice never hides one you have not read.

In the rare case that one stroke cannot be drawn at all — working out its shape stopped the app's drawing worker — the rest of the board is still drawn, that stroke is left out of the picture, and the same box says how many strokes are missing. The stroke stays in the file unchanged, and it is not tried again until the page is reloaded.

### Drawings
A **drawing** (\`.drawing\`) is a canvas with no pages at all — an endless sheet in every direction, for diagrams and thinking rather than for a page you intend to hand in. Its **Minimap** (bottom right) shows the artwork and your current view: click or drag in it to move there; with the minimap focused, the arrow keys move a quarter of the view (a full view with \`Shift\`), and \`Home\` / \`End\` go to the artwork's top-left / bottom-right. A drawing has no paper, and its own **Theme**.

**Drawings and notebooks from an older version of the app** — a \`.tldraw\` drawing, a \`.notebook\` written by the old app, or tldraw's own \`.tldr\` file, from any tldraw version — are never changed here. Which ones are older is read from the file itself each time it opens, not from its name. When you open one, the app asks first: **Make a copy and open it** writes a copy in this app's format beside the original, in the same folder, and opens it in the same tab, where you were looking; **View the original** (or \`Escape\`) opens the old file read-only, exactly as it was. Not copying is never remembered, and the question is not asked again while that tab stays open.

A read-only old board says **Older version · view only** at its top left (hover it for why), and you can still move around it, zoom and change sheets or pages; select and copy with \`Cmd/Ctrl + A\` and \`Cmd/Ctrl + C\` (\`Cmd/Ctrl + Shift + C\` copies as a picture); and print it or export it to PDF from its **☰** menu (\`Cmd/Ctrl + P\` prints) — what is printed and exported is what the board shows, its text drawn as it is on screen. A notebook's **⋯ → Export to PDF** works as it does for any notebook; chosen while its editable copy is being made, it waits for the copy to open and exports the copy. Its **Make an editable copy** button makes the copy at any time; so does right-clicking the file in the sidebar, which works without opening it first. Tabs that come back when you reload or switch vaults reopen read-only with that button rather than asking again. The agent cannot change an old board either, and tells you to make a copy.

The copy is named after the original and never replaces anything: \`Practice.tldraw\` becomes \`Practice.drawing\`, and a notebook \`Notes.notebook\` becomes \`Notes copy.notebook\`; if that name is taken by a file or a folder, it is \`… copy 2\`, \`… copy 3\` and so on. Making a copy twice makes two copies. Its pictures are kept in the folder's \`.Assets\`, like any other board's. If the copy cannot be written (the disk is full, the folder became read-only), a message says why, nothing is left half-written, and the original stays open to view. The original stays where it was, untouched: delete it yourself once you no longer want it.

Elbow connectors from earlier versions keep their ends, their attachments, their arrowheads and their label; this app draws their bends itself, so an elbow may bend in a different place than it did before, still joining the same shapes by the same sides. If a few items cannot be shown here (a shape kind this app does not have, a video that played from a web address), the board still opens without them and says so once in a notice at the bottom, which **Dismiss** puts away; they stay in the original file, and a copy keeps them in its own file too. A print, a PDF export and the page thumbnails show the board as it is on screen, so they leave those items out as well. A copy starts with the Draw tool, as a new drawing does, whatever tool the old app had chosen. Repairs worth knowing about, such as pen pressure that could not be read, are listed in the same notice. A file that cannot be read at all says why in one sentence and is left exactly as it was.

### Notebooks
A **notebook** (\`.notebook\`) is ruled paper you can write on: the closest thing here to a paper pad, and what to reach for when you are doing an assignment by hand rather than taking notes in Markdown.

A notebook scrolls like a PDF: swipe up and down to move through the pages, and pinch to zoom. At full width the page fills the screen edge to edge, and the pages can never be swiped off screen. \`Page Up\` / \`Page Down\`, \`Space\` / \`Shift + Space\`, \`Home\` and \`End\` move by pages.

The bar across the top of a notebook is its paper:

- **Paper size** — Letter, A4 or Legal — and **Portrait / Landscape** (the button names the current way round; click it to turn the paper).
- **Paper ruling** — lined, grid, dotted or blank. Changing it re-papers what you have already written; nothing you have drawn moves.
- **Add page** adds a page at the bottom. You rarely need it: writing near the bottom of the last page adds the next one for you, before you run out of room.
- **Delete last page** removes the last one. An empty page just goes; one with writing on it asks first, because that writing goes with it.
- **Page thumbnails** opens a strip of pages down the left, showing what is written on each; click one to go there.
- **Invert page colours** turns the paper black and the writing light, for working at night. It only changes how the notebook looks on screen; a PDF exported from it is still printed on white.
- The **page box** shows the page you are on; type a number and press \`Enter\` to jump.

The bar always stays one row. In a narrow pane (several panes side by side, say) the paper settings move behind the **⋯** button at the bar's end, then the thumbnails and invert buttons too; the page box always stays on the bar. Click **⋯** to open them; \`Escape\` or a click elsewhere closes it. A PDF you are writing on does the same with its thumbnails and invert buttons.

#### Exporting a notebook to PDF
Choose **⋯ → Export to PDF** in the notebook's pane header to write a PDF beside the notebook — \`Assignment 3.notebook\` becomes \`Assignment 3.pdf\`. The ruling and your handwriting are both drawn into it as real vector artwork, so it stays sharp printed or zoomed in, and the pages are ordinary PDF pages that anything can open. Every sheet is included, in order. If some content cannot be drawn faithfully, the export stops rather than silently leaving that artwork out.

The notebook stays the original you keep writing in. Exporting again uses the same PDF name rather than leaving a pile of copies. An existing PDF is kept in the folder's Trash before it is replaced. The app asks first unless it is this notebook's unchanged last export; if the target changes during export, it asks again. Close the target PDF's tab before replacing it, so an open document cannot lose unsaved annotations. A folder with the PDF's name cannot be replaced.

The exported PDF remembers which notebook it came from, so pressing the pen on it **opens that notebook** instead of annotating the PDF as if it were someone else's. That is what you want: annotating the export would make a third file holding marks the notebook knew nothing about, and your next export would neither include them nor replace it. The link survives renaming the PDF, and if the notebook itself is gone the app says so rather than quietly forking.

Everything around a page — the toolbars, the style panel, the space the pages sit on — follows the app's theme. The **pages themselves stay white** in either theme, because that is paper: it is what the exported PDF prints on, and ink that changed colour with the theme would come out invisible in the file. Notebook and PDF ink therefore use a paper palette and do not offer the board's Theme menu or its theme shortcut.

### PDFs
PDFs open **inside the app** in their own pane, in a reader: scroll them, select and copy their text, search every page, follow their links, and write on them. The pane header's **⋯** switches between **Original PDF** (the pages as they are) and **Read extracted text** (an optional text view), and the pen beside it — or \`Cmd + E\` / \`Ctrl + E\` — switches between reading and **Annotate**, the same toggle every other file has.

#### Reading a PDF
- **Moving:** scroll, or use \`Page Up\` / \`Page Down\` (a screenful), \`Home\` and \`End\` (first and last page). The **page box** at the bottom right shows the physical page you are on; type a number and press \`Enter\` to jump.
- **Zoom:** pinch or hold \`Ctrl\` and scroll, use the \`+\` and \`-\` keys, or the **−** / **+** beside the zoom percentage at the bottom right.
- The buttons at the bottom right, from the left: **Contents** (the PDF's bookmarks, when it has them — click a heading to jump there, arrow keys move through and open the tree, \`Enter\` follows a heading, \`Escape\` closes it), **Page thumbnails** (a strip of pages down the left, using the same page numbers as the page box, with the current page highlighted), **Invert page colours** (dark pages for reading at night, while reading and while writing on them — only how they look, never the file), the two **rotate** arrows (below), and **PDF feature limitations**, which lists the file's known restrictions.
- **Right-click** the page for **Copy**, **Copy as quote**, **Search vault for selection**, **Find selection in this PDF**, **Copy page text**, **Select all** and **Read extracted text**.
- If a page cannot be rendered completely, a notice stays on that page (an error whose page is unknown appears above the document) and its thumbnail says **Thumbnail unavailable** rather than pretending to be blank. **Try again** reopens the PDF; it never changes the original file. In Annotate, switch to View to retry without disturbing your ink. If rendering makes no progress for a while, **This PDF is taking longer than usual** lets you keep waiting or **Try again**; a renderer restart can affect other open PDFs, and each says so. If the PDF reader itself cannot load, its column says so with **Try again** (or **Reload**, when a newer version of the app replaced it); if it keeps failing, reload the app. Very long PDFs start with estimated page sizes, which settle as you visit pages.
- **PDF rendering quality was reduced to fit memory** appears on a PDF (or **Rendering quality was reduced to fit memory** on a board) only when that document has really been drawn below full sharpness for about a second, and it goes by itself once the page is sharp again. **…is limited by available memory** means the pages on screen did not fit for that long and goes once they do. Neither is an error: each offers **Dismiss** only, since reopening the file would not help. Freeing memory the app no longer needs happens quietly and never shows a notice. **Retry** appears only when a page or the PDF really failed to render; after it, a short note says the retry is under way and clears itself as soon as the pages are sharp.
- Screen readers find a landmark for every physical page; moving to one brings that page into view. **Read this PDF as text**, at the start of the viewer, opens the whole-document accessible view.

#### Finding and copying text
In **Original PDF**, press \`Cmd + F\` / \`Ctrl + F\` to search every page, including pages you have never opened. A short single-line selection pre-fills the bar; otherwise it keeps this pane's last query. Matching ignores case and accents, folds ligatures, and matches across line breaks, hyphenated line ends and PDF text-item boundaries. The count shows progress and stops at **10,000+** matches. Scans without selectable text are not OCR'd.
- In the input, \`Enter\` / \`Shift + Enter\` move to the next / previous match. \`Cmd + G\` / \`Ctrl + G\` and their Shift forms do the same from the bar or the page. Next waits for an unfinished scan rather than wrapping early.
- \`Escape\` or **×** closes the bar and leaves the current match selected, ready to copy. Switching tabs keeps each pane's query and results.
- Chrome's own **Edit → Find** sees only the pages whose text is built, not necessarily every page. Use the keyboard shortcut for a complete search.

**Copying.** Select a passage and press \`Cmd + C\` / \`Ctrl + C\`. With a page focused, \`Cmd + A\` / \`Ctrl + A\` visibly selects the built text and marks **the whole document** for copying; follow it with \`Cmd + C\` / \`Ctrl + C\` to gather every physical page, including pages you have never opened, separated by a newline. A notice shows progress or a blocked clipboard write. Changing the selection returns to ordinary passage copying. Whole-document text above **16 MiB** is refused rather than silently cut off. A PDF that forbids copying cannot be selected, copied, searched as text or read as text by the agent.

**Read extracted text** (in **⋯**) is a separate reading view with physical page labels, its own Find (\`Cmd/Ctrl + F\` while it is focused), Copy and the shared **Aa** reading controls. Text is extracted by the PDF engine, with no OCR: scans may have no text, existing OCR may differ from the pixels, and columns, tables and maths may come out in an imperfect order — the text-order warning means that, not necessarily missing text. Copy across pages puts a separator between them. Word emphasis is inactive there; choose **Original PDF** to use it on the page itself. Choosing Original returns to the page images to check layout, pictures, links and annotations; an unchanged round trip restores where you were. Reading positions and an explicit Text choice are remembered per vault and file; a Text passage saved by an older version is matched by its words and labelled when the match is approximate.

**Word emphasis** in the pane header paints supported glyphs directly on the original page, including while annotating, and keeps the same layout, links and annotations (see *Word emphasis* below). Image-only scans, hidden OCR, clipped or covered text, missing font mappings and unsupported painting routes stay original, and the header says why. **Aa** does not replace a native PDF's fonts or geometry.

#### Turning a sideways scan the right way up
The two curved arrows at the bottom turn the pages a quarter at a time — \`]\` turns right, \`[\` turns left. They turn the whole document; hold \`Alt\` (\`Option\`) while clicking an arrow to turn only the page you are reading, which is what a single crooked page in an otherwise straight scan wants. The page turns as you press, and sharpens a moment later once the turned file is saved and read back; press as quickly as you like, every press counts. Unlike inverting, this is a real change to the file: the PDF is saved the way round you left it and opens that way here and in anything else. The rest of the file is kept exactly as it was — the turn is added after it — and four turns bring the file back to exactly what it was. There is no undo for a turn: the opposite arrow is the undo. If a turn cannot be saved the page turns back and a message says why.

**A PDF you have written on turns with your marks**, the way a sheet of paper turns with the ink on it: every stroke, shape, note and picture stays on the spot of the page it was drawn on, at the same size, and text turns with its page. Turn it as often as you like and keep writing in between — in Annotate the turned page is the page, so new marks land where you draw and existing ones select, move and erase as usual. Four turns in a row give back exactly the file you had. Marks you have not saved yet are saved first, then turned. Switching to Annotate while a turn is still being saved waits for it — a note at the top says so — and Annotate opens by itself once the turn has finished (on the pages as they were, if the turn could not be made); press the pen again to stay in reading. Closing, renaming or moving the PDF waits for the turn too. The undo history of Annotate starts afresh after a turn (the opposite arrow undoes the turn itself). Annotations in the older Classic format are converted first: Annotate offers **Convert legacy annotations…**, and once the converted annotations are saved (with your next change) the pages turn with them. A notebook's export turns like any other PDF; exporting the notebook again asks before replacing it and keeps the turned file in **Trash**. Left alone, with a note saying why: a signed or encrypted PDF, a PDF whose annotations are damaged, cannot be checked with certainty, come from a newer version or were saved with a different version of the app's PDF engine, and one changed by another program since its annotations were saved here.

#### Writing on a PDF
Press the pen in the pane header (or \`Cmd + E\` / \`Ctrl + E\`) and the PDF opens on the board, **on the page you were reading**, with the same tools, style panel and menus as a notebook. The bar at the top holds **Page thumbnails**, **Invert page colours** and the page box. Swiping scrolls the pages up and down and pinching zooms; at full width the page fills the screen edge to edge, and you can zoom in past that. Switching back to reading returns you to wherever you stopped writing. Save with \`Cmd + S\` / \`Ctrl + S\`, or let autosave finish. **Menu → Export → PNG** captures the pages and the ink together, without inversion.

**The marks go into that PDF, not into a copy.** There is no second "(annotated)" file to keep track of: the file you annotated is the file you annotate again. It is still a real PDF that opens anywhere, with your marks drawn in as vector artwork and the document's own text still selectable underneath.

Your original is not lost. The file quietly carries a pristine copy of the PDF as it was before you touched it, alongside the editable form of your strokes — which is what lets you come back days later and move, recolour or erase a mark rather than being stuck with it. It is also why annotating never builds up: every save redraws from that pristine copy, so the marks never thicken or double no matter how many times you edit. Each page carries only the marks drawn on it, and a page you have not written on keeps its own content, so beyond that copy the file grows only by your marks, however it was saved: autosave, \`Cmd + S\`, the app's Reload or closing the PDF. Returning to Original after saving shows the actual saved pages with the ink.

Annotated saves also carry a write mark. If another program changes the file after a marked save, Annotate stays read-only and explains that rebuilding from your last editable version would drop those changes. **Keep the file as it is** (the default, or \`Escape\` while the notice is focused) leaves it unchanged. **Annotate from my last version** first keeps the exact current PDF in that folder's **Trash**, then enables editing. A malformed or unsupported mark offers the same safe choice. A changed or deleted file must be resolved before this can continue; a failed copy enables nothing and offers Retry.

Older annotated PDFs without a mark can still be edited: before their first save here, a copy of the current file is kept in **Trash** and the saved PDF gains the mark. For annotations in the older Classic format, Annotate offers **Convert legacy annotations…**: it checks the source, asks first, and keeps the exact original in **Trash** before native editing starts (one copy: the first save keeps it there rather than adding a second, and keeps a new one only if that copy was deleted meanwhile); cancelling or a refused conversion leaves the original unchanged.

Editable annotations are limited to **32 MiB**: beyond that the save is refused without changing the PDF, and the unsaved annotations stay open. A refused save is never reported as Saved and cannot be dropped by closing its tab or switching vaults; closing or switching waits for a pending save. A browser or system crash cannot wait for an unfinished save.

#### PDFs that stay read-only
**A PDF that cannot be written on safely stays in the reader.** Before the pen opens, the app checks what the file actually carries, not its name. A PDF holding an unrelated \`original.pdf\`, attachments that cannot be read or that contradict each other, or annotations written by a newer version stays read-only, with a note saying why; drawing and saving change nothing in it, and you can still read, select, copy and find in it. Choose **Retry** if an attachment could not be read; otherwise open it in the version of the app that wrote it. Never delete attachments from your only copy just to make the note go away. Existing attachments are kept when you save; if two have the same name, a notice gives the names used to keep both.

**Signed or certified PDFs** — and PDFs whose write safety cannot be established — are read-only for annotation and rotation. Where available, **Save unsigned annotated copy** asks first and creates a different file; it never overwrites the signed original or claims its signatures cover the copy. **Encrypted PDFs** ask for their password (kept only while the PDF is open, never saved; cancel leaves the file unchanged and Retry asks again) and cannot be annotated or rotated, so the encrypted file is never rewritten. Form fields show their saved appearance and cannot be filled in; XFA forms may be missing; PDF scripts, form submission and launch actions never run. A rare PDF using \`/UserUnit\` may show at a different relative size in another viewer.

**Fonts.** When a PDF uses fonts it does not include, the reader substitutes bundled Noto faces where supported; ambiguous Chinese uses Simplified Chinese, and a known character set takes precedence over a conflicting language hint. **PDF feature limitations** states this policy for every PDF, not only those that needed it.

#### Printing a PDF
Choose **Print…** in the PDF's **⋯** menu while reading it (or press \`Cmd + P\` / \`Ctrl + P\` while it has focus), choose **Prepare PDF** to save any pending annotations, then **Open PDF** to open the exact saved file in a new browser tab, and print from the browser's PDF viewer there. A blocked pop-up or a changed file is reported; allow pop-ups or resolve the notice and try again. An encrypted PDF may ask for its password again there. To print a notebook, press \`Cmd + P\` / \`Ctrl + P\` on its board, or export it to PDF first.

### EPUB books

Open an imported \`.epub\` from the file tree, a file-name search result, a restored tab or a vault URL. Books are read-only: reading, Find and appearance never change their bytes. To add a book, drag its original file into the vault. There is no New EPUB command.

**Contents** opens the reading order and any publisher-supplied **Print pages** and **Landmarks**; print labels are shown only when the book provides them. **Find** searches canonical book text and reports incomplete sections. **Aa** changes local fallback fonts, default size and line spacing, line width, margins and reader theme. Explicit publisher typography and colors take precedence; fixed pages retain publisher geometry. **Scroll** follows the reading order; **Pages** uses reading screens. Previous/Next move through the book and **Return** goes back after a jump. Select text to copy it; visually hidden publisher prose is omitted from Copy while canonical Find positions stay stable. The app's book menu offers Copy and Find. A book link outside the publication asks before opening a website.

The pane header’s **⋯** also offers Contents, Find, Reading appearance and Scroll/Pages. **Cmd/Ctrl+F** searches the focused book from its header or content.

Static fixed-layout sections preserve their page geometry: Aa offers fit, zoom and facing pages. Word emphasis paints eligible original XHTML text in both fixed and reflowable sections, including mixed-layout books. Image/SVG-only pages remain original and show why emphasis is inactive. Unsupported/protected or unreadable content reports why and offers Retry; this reader does not unlock DRM, run publisher scripts, fetch remote book assets or provide OCR. ZIP64 archives and animated/GIF/AVIF illustrations are unsupported; unavailable images are reported while prose remains readable. Exceptionally large Contents can exceed the metadata limit. Very large sections keep their text but may report Word emphasis unavailable. Complex author styles and reading order may differ from a publisher's reader.

Position and reading layout live only in this browser, separately for each vault and file. Closing a pane releases its book frame. Switching vaults, moving a book or returning from Graph keeps a browser-local position; a changed edition restores the matching section occurrence and passage when available, otherwise it opens a valid section with an approximate-position notice. This is local reading in an already loaded app, not an offline installation guarantee.

### Word emphasis

The **Word emphasis** button in a reading header (three short lines, each starting heavy), its **⋯** row, and **Settings → Reading** share one preference, initially Off, across supported reading views. There are no per-file overrides. It visually emphasizes prefixes of eligible Latin prose, including rendered table body prose. In Markdown and EPUB, authored bold, code, math, URLs and unsupported scripts remain ordinary. PDF emphasis follows its original glyph mappings and supported painting routes. This optional visual heuristic makes no reading-speed or accessibility claim.

It leaves the source, save state, undo history and copied text intact. PDF and EPUB emphasis paints eligible glyphs in the same document view, preserving original layout, artwork and reading position. Switching it Off restores the original paint. Image-only pages and unsupported text profiles remain unchanged and show why the control is inactive, while retaining your preference. Source editing and code/TeX keep their existing presentation. Notes, TXT and extensionless files keep their existing Markdown presentation and editor typography. Toggle with Enter/Space or a pointer; no new global shortcut is added. Reading preferences are stored in your browser, never in the vault.

---

## 6. Images, Assets, and Trash

### Managing Images
You can seamlessly add images to your markdown notes:
- **Paste:** Simply copy an image to your clipboard and paste it (\`Cmd + V\` / \`Ctrl + V\`) directly into the editor. This is how you get a picture *into a note* — see below.
- **Drag and Drop:** Drag an image file from your computer onto a folder in the file tree (or onto the empty space below it, for the vault root) to copy it into your vault as an ordinary file. A name already in use gets numbered rather than overwritten.

### Working With an Image
An image in a note behaves like an image in a word processor, not like a piece of text. It stays a picture at all times — clicking it never turns it back into markdown for you to retype — and in **Edit Mode** clicking it selects it and puts three small buttons on it:
- **+ and −** (top right) resize it, a step at a time.
- **The bin** (top left) removes it. So does pressing \`Backspace\` while it is selected. Either way you are asked first.

In Reading Mode a picture is simply a picture, and clicking it does nothing.

### The \`.Assets\` Folder
When you paste an image, the application does the following in the background:
1. It automatically creates a hidden folder named \`.Assets\` in the same directory as your active markdown file.
2. It generates a uniquely named image file (e.g., \`Pasted image 20240101120000.png\`).
3. It saves that image into the \`.Assets\` folder.
4. It inserts a reference to that file into your note, which renders as the image itself.

Every folder gets its own \`.Assets\`, and a note only ever shows pictures from the one beside it. That means a folder is self-contained: move it, copy it onto another machine, or share it, and its notes still render. (Pictures from an older version of the app, saved higher up the vault, are still found — the app looks up through the parent folders when a note's own \`.Assets\` doesn't have them.)

Your notes are still ordinary Markdown: what is actually written in the file is \`![[filename.png]]\`, and a resized picture records its width as \`![[filename.png|320]]\`. Anything else that reads Markdown sees exactly that. The editor simply spares you from typing it.

### Removing an Image
Deleting a picture — with the bin, with \`Backspace\`, or just by deleting the text around it — also retires the image file: a second later it moves out of \`.Assets\` and into that folder's \`.Garbage\`, so your folders don't slowly fill up with pictures nothing shows any more. A picture shared with another note or a board in the folder stays until neither needs it; if a board cannot be read, the app keeps the picture rather than guessing.

Nothing is lost by this:
- An image another note **in the same folder** still shows is left exactly where it is.
- Undo (\`Cmd + Z\` / \`Ctrl + Z\`) brings the picture back — the image file comes back out of \`.Garbage\` with it.
- And anything that was retired is still sitting in \`.Garbage\`: it is listed in the Trash bin like anything else, and putting it back returns it to \`.Assets\`, where your notes can show it again.

### Opening Media
Click a \`.pdf\` in the file tree to open it in the app's PDF pane, not as text. Images such as \`.jpg\`, \`.jpeg\`, and \`.png\` open in a browser tab.

### The Trash System
To prevent accidental permanent data loss, deleting a file does not erase it from your hard drive. Instead, it moves the item into a hidden \`.Garbage\` folder located in the same directory as the file — deleting \`Maths/Calculus/notes.md\` puts it in \`Maths/Calculus/.Garbage\`, so a deletion stays next to the notes it came from. Deleting the same name twice keeps both copies (the second becomes \`notes (1).md\`).

Deleting a **folder** works exactly the same way, and takes everything inside it along: deleting \`Maths/Calculus\` puts the whole folder in \`Maths/.Garbage/Calculus\`, with its notes, its sub-folders and the pictures from its own \`.Assets\` still in place — so a recovered folder works again just as it did. (A picture stored higher up the vault, from an older version of the app, stays where it is and is not copied along.) Any notes from that folder you had open are saved first and then closed, so nothing you had just typed is left behind. A large folder takes a moment to copy; the top bar says so while it does.

### The Trash Bin
The **bin icon** in the row of icons at the bottom of the sidebar shows everything you have deleted in the vault you have open — without your going near Finder or Windows Explorer.

Opening it looks through every \`.Garbage\` folder in the vault, from the root down. Nothing about your trash is written down or remembered between openings, so what you see is always what is actually on disk — and a big vault takes a moment to look through. The window says so while it works.

**What you see.** One list of everything trashed anywhere in the vault, newest deletion first, each row naming the folder it came out of (which is where it goes back to) and when it went. A deleted **folder** is a single row: click it to look inside, and use the trail at the top to come back out. Anything you deleted from that folder *before* you deleted the folder itself is listed on its own at the top level instead of inside it — it was a separate deletion, so it is offered back separately. Clicking a note shows it read-only beside the list, which is how you tell \`notes.md\` from \`notes (1).md\` before putting either back. Notebooks, drawings and PDFs are listed with their size and date but not drawn.

**Put back** (the arrow on a row) returns an item to the folder holding the \`.Garbage\` it was found in. It does not rebuild the folders it used to live in: a note from four levels inside a folder you deleted comes back beside that folder's old home, not under a recreation of an ancestry you no longer have. Put back a single note out of a deleted folder and only that note leaves the bin — the rest of the folder stays there. A picture the app retired for you goes back into \`.Assets\`, where your notes can show it again.

If something of that name is already there, you are asked: **Replace**, **Keep both**, or leave it. Replacing does not erase what is there now — it moves it into that folder's own \`.Garbage\`, where it appears at the top of this list. Keeping both puts yours back under a numbered name, and the top bar tells you which.

One thing does not come back: an icon or colour you had given a file or folder is forgotten when you delete it, so a restored item looks like any other.

**Delete permanently** (the bin on a row) and **Empty bin** (bottom left) are the only two things in this application that actually erase anything. Empty bin removes every \`.Garbage\` folder in the vault at once, retired pictures included. Both ask first, and neither can be undone.

**Escape** closes the window, and so does clicking the dimmed area around it. If you would rather dig a file out by hand, you still can: every \`.Garbage\` is an ordinary folder sitting beside what it holds, so Finder or Windows Explorer reaches it too.

---

## 7. Markdown Syntax Reference

The editor supports standard Markdown and advanced formatting.

### Headers
# Header 1
## Header 2
### Header 3

### Text Styling
Wrap the text in the marker on both sides. What you type, and what you get:
- \`**Bold Text**\` gives **Bold Text** — double asterisks.
- \`*Italic Text*\` gives *Italic Text* — single asterisks.
- \`~~Strikethrough~~\` gives ~~Strikethrough~~ — double tildes.
- \`==Highlighted Text==\` gives ==Highlighted Text== — double equals signs.

Note how each marker above shows as itself when it is wrapped in backticks: anything inside \`code\` is text being quoted rather than formatting being applied, which is how this guide can print the syntax it is describing.

### Links
Three ways of writing one, all of them ordinary Markdown:
- \`[Anthropic](https://www.anthropic.com)\` — a label, and the address behind it. Only the label shows.
- \`<https://www.anthropic.com>\` — the address as its own label. The angle brackets are syntax and hide like any other.
- \`https://www.anthropic.com\` on its own — just paste it in. \`www.anthropic.com\` and a plain email address are picked up the same way.

A link's label is ordinary text, so the formatting above works inside it — \`[the **important** part](https://www.anthropic.com)\` gives you [the **important** part](https://www.anthropic.com), and the whole of it is one link.

**In Read Mode a link is clickable, and opens in a new browser tab** so the note you were reading is still there behind it. It is a real link, so hovering over it shows the browser where it leads. In Edit Mode it stays text, so that clicking it puts the cursor in it — press \`Cmd + E\` / \`Ctrl + E\` to read, then click.

Only addresses that lead somewhere outside the app are made clickable — \`https:\`, \`http:\`, \`mailto:\` and \`tel:\`. A link to a path inside your vault, or to a heading (\`[see below](#chapter-two)\`), is styled but does nothing; use \`[[Note Name]]\` for those (see *Wiki Links*). The same goes for a \`javascript:\` or \`data:\` address, the two a note from someone else could use to attack your vault: it still looks like a link, but clicking it does nothing at all.

An address written *inside* a label — \`[read this https://example.com now](https://www.anthropic.com)\` — is part of the label and nothing more: the whole label leads to the one address in the brackets after it, so there is never a second, different destination hiding inside a link you are about to click.

### Wiki Links
\`[[Note Name]]\` links to another note in the vault by its name, and \`[[Note Name|what to call it]]\` shows different text. Type \`[[\` and the editor offers the notes you have. Clicking one **opens that note in a new tab inside the app** — it never leaves the browser page you are on. This works in both modes.

**Neural Brain** and **Linked mentions** follow these note links only: a web link creates no relationship between notes, even when its address ends in \`.md\`. When two notes share a name, a note link chooses the first of them in the vault's own order, whatever order the sidebar is sorted in.

### Lists
Unordered Lists:
- Item 1
- Item 2
  - Sub-item A

Ordered Lists:
1. First step
2. Second step

### Blockquotes
> This is a blockquote. It spans multiple lines if necessary and visually groups quoted text.

### Code
Inline code: \`const example = true;\`

Code blocks:
\`\`\`javascript
function helloWorld() {
  console.log("Hello");
}
\`\`\`

Code blocks may use backticks or tildes (at least three matching characters; the closing run may be longer). In Reading mode the fence lines stay hidden; Copy code copies only the lines between them. Use mermaid after either opening fence to draw a diagram. In Edit mode, move the caret into the block to reveal its source.

### Tables
| Syntax | Description |
| ----------- | ----------- |
| Header | Title |
| Paragraph | Text |

A table stays a table. Click a cell and type in it; arrow up into it from the line below and the cursor lands in a cell. It never turns back into markdown under your hands. What the file holds is still the ordinary pipe-and-dash table above — the grid is simply an easier way to work on it, exactly as an embedded picture is an easier way to work on \`![[picture.png]]\`.

Getting around, and editing:
- **Tab** and **Shift + Tab** step to the next and previous cell, wrapping onto the next row; from the very last cell, Tab adds a row and lands in it. **Enter** moves down a row, and from the last row it adds one too. **Escape** leaves the table, with the cursor just after it.
- **Shift + Enter** breaks a line inside a cell. It writes \`<br>\`, which is the only way Markdown has of doing that.
- The two small **+** buttons at the corners, top right and bottom left, add a column and a row at the end. Each appears when the pointer comes near its edge.
- **Hover a row or a column** and a small grip appears beside it: left of the row, above the column. Click it to insert, **move** or delete that row or column, and on a column to **align** it left, centre or right. The alignment is written into the file as GFM's \`:---\`, \`:---:\` and \`---:\`.
- **Alt + ↑** and **Alt + ↓** move the row you are typing in up and down.
- **Right-click a cell** for everything else: *Cut*, *Copy* and *Paste* within that cell, *Insert row above* / *below*, *Insert column left* / *right*, *Delete row*, *Delete column*, *Delete table*. None of them asks you to confirm, because a single \`Cmd + Z\` / \`Ctrl + Z\` undoes any of them.
- The cell you are in shows its **raw text**, just as the file has it: a cell holding \`**bold**\` shows the asterisks while you are in it and the bold word again once you leave. That is the same thing the editor does when you put the cursor on a bold word anywhere else.
- **Maths renders in a cell.** Write \`$x^2$\` and the cell shows the formula, exactly as it would in the body of a note; step into the cell and the \`$…$\` comes back, like any other markup. A \`$$…$$\` inside a cell is drawn inline rather than as a centred block, because a cell is one line.
- \`Cmd + B\` and \`Cmd + I\` do not reach inside a cell. Type \`**bold**\` and \`*italic*\` there yourself.
- A pipe inside a cell is written \`\\|\`, and the editor writes that for you — type a \`|\` into a cell and the file gets \`\\|\`, so the row keeps the number of columns you can see.
- The colons in the second row are honoured: \`| :--- |\` is left-aligned, \`| :---: |\` centred, \`| ---: |\` right-aligned. Editing a cell never disturbs them.
- Nothing you did not edit is rewritten. Change one cell and every other row comes back byte for byte, spacing included — a table you have lined up by hand stays lined up.

To make a new one, choose **Insert table…** from the pane's **⋯** menu, or right-click in a note and choose it there, then sweep across the grid to the size you want and click (the first row is the header, so the smallest table is two rows). If you already know your columns, type the header row, such as \`| Name | Grade |\`, and press **Enter**: the \`| --- |\` row and an empty row appear, with the cursor in the first cell. Or just start typing one: the moment the header row, the \`| --- |\` row and one body row are all there it renders, and you carry on typing in the last cell. Pasting a Markdown table in does the same.

A table written inside a code fence stays as text — it is being quoted, not tabulated:

\`\`\`markdown
| Syntax | Description |
| ------ | ----------- |
| Header | Title |
\`\`\`

---

## 8. LaTeX Math Expressions

The application natively supports advanced LaTeX mathematical typesetting.

### Inline Math
Surround your expression with single dollar signs:
The quadratic formula is $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$

### Block Math
Surround your expression with double dollar signs on their own lines:
$$
E = mc^2
$$

$$
\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}
$$

### Math in a Table
Both forms work inside a table cell too — see section 7. Two things to watch. A cell resolves \`\\\\\` down to a single backslash on the way in, so LaTeX that needs a real \`\\\\\` — the row separator inside \`\\begin{matrix}\`, say — has to be written \`\\\\\\\\\` there; those environments then lay out their rows normally. A \`\\\\\` on its own, though, does nothing at all in a cell: a cell is one line, so the break is dropped rather than splitting the formula and growing the row. Everything else carries across unchanged.

---

## 9. The AI Agent

The sparkles button at the bottom of the sidebar (or \`Cmd + Shift + X\` / \`Ctrl + Shift + X\`) opens a chat panel on the right of the window. In it you talk to an AI coding agent you already use — **Claude Code**, **Codex** or **OpenCode** — about the vault you have open. Drag the panel's left edge to make it wider or narrower.

### What it needs
- **The agent itself, installed and logged in on this computer.** Log in once in a terminal, the way you normally would: run \`claude\` and type \`/login\`; or \`codex login\`; or \`opencode auth login\`. The panel warns you when the agent you picked is not installed or not logged in, and shows the command to run.
- **VaultAgent**, a small helper that runs quietly in the background (no window, no Dock or menu-bar icon) and starts when you log in. A browser page cannot start programs, so the helper is what runs the agent for you. The panel's guide has the download for your system:
  - **macOS:** open \`VaultAgent.pkg\`. The first time, macOS blocks it because it is not from the App Store: open **System Settings → Privacy & Security**, click **Open Anyway**, and follow the installer. macOS then says "Background Items Added".
  - **Windows:** run \`VaultAgent-Setup.exe\`. If SmartScreen stops it, click **More info → Run anyway**.
  - **Linux:** make the downloaded file executable and run it once (\`chmod +x vaultagent-linux-x64 && ./vaultagent-linux-x64\`); it installs itself as a background service for your user.
- Then click **Connect** in the panel. Chrome asks once whether this site may talk to apps on your computer — choose **Allow**. Until you click Connect the page never tries to reach the helper. If you chose Block by mistake, click the icon at the left of the address bar, open **Site settings**, and set **Local network access** to **Allow**; the panel reconnects by itself.

### Chatting
Opening the panel puts you straight in the box at the bottom, and closing it puts you back where you were. Type there and press **Enter** to send (**Shift + Enter** for a new line). Paste images straight from the clipboard, drop them onto the box, or use the attach button. Right-click the box to **Paste**, or selected text anywhere in the panel to **Copy** it. Pick the agent in the panel's **⋯** menu, which also shows whether each one is installed and logged in, and the model and how hard it should think (effort) beside the message box — the model list opens with the few worth choosing between, and **Show all** has the rest — each chat remembers its own choice, and a new chat starts with the last one you used. Switching the agent starts a new chat. **Stop** ends a reply early.

### How it answers, and Learning Mode
Answers are meant to be short: the agent is told to lead with the answer, keep to a few sentences unless you ask for more, skip the preamble and the recap, and never paste back a diff the panel already shows you. Maths comes back as real maths, typeset the way your notes do it — it is told to write LaTeX (\`$x^2$\`, or \`$$…$$\` on its own line) and never to fake a formula with symbols like ∑ and √.

When you are trying to **learn** something rather than get something done, that is the wrong shape, so the panel has a **learning mode** — the graduation cap beside the model chip. In learning mode the agent gives you **one idea at a time**: a short explanation with a concrete example, often built from your own notes, then one question back to check it landed, and then it waits for you. Say you follow and it takes the next step; say you're lost and it goes smaller.

The cap has three settings, and clicking it moves to the next:
- **Automatic** (the default): the panel decides per message. Ask it to explain something, say you don't understand, or ask why something works, and it teaches; ask it to add a table or fix a typo and it just does it. The cap **lights up** while a lesson is under way, so you can always see which one you are getting.
- **On**: every answer is taught step by step.
- **Off**: it always answers directly.

The setting is yours, not the chat's: it stays as you left it. A lesson in progress is remembered until you start a new chat or reload the page.

### Changing something you already sent
Point at one of your own messages and a **pencil** appears. Click it, change the words, press **Enter** (or **Send**), and the agent answers the new version.

The old one is not thrown away. Your message now has **two versions**, and a small **‹ 1/2 ›** under it switches between them — along with everything that followed each one. Edit again and you get a third, and so on. It works on any message in the chat, not just the last, and a chat you started before this update can be edited the same way.

Each version is a separate conversation from that point on: the agent answering your edited message does not know about the version you replaced, which is the point of editing it. It is told what came **before** the message you changed, so it still has the thread.

Each chat keeps its own conversation. The chat list at the top lets you go back to an earlier one or start a new one, and deleting a chat removes it for good (after asking), including the agent's own record of it.

### What the agent can see
You never need to tell it what you are looking at. With **every** message it is told, fresh, which tabs and panes you have open, which one you are in, and exactly where you are in each: the lines on screen and your selection in a note (unsaved edits included), the page, zoom and selected text in a PDF, and what is in view on a drawing or notebook page. When the tab you are in is a drawing, notebook or PDF, a picture of what is on screen goes along too — but only when it changed since your last message. Scroll, switch tabs or keep writing between messages and the next message knows.

It can also look things up on the web. With VaultAgent 0.2.2 or newer, the agent can page through a large board's shapes instead of stopping at the first 200; if the board changes between pages, it starts the listing again.

### What the agent can change
It can read and search every file in the vault, edit notes, create notes and folders, rename and move things, and delete them — to the Trash, never for good. On drawings, notebooks and PDFs it can add text, sticky notes, shapes, arrows and freehand strokes, and move, restyle or remove shapes. Every change happens straight away and shows in the chat as a card (with the lines it changed); the card's **Open** takes you to the file. A change made in a note you have open appears in it live, and \`Cmd + Z\` undoes it like your own typing. A drawing, notebook or PDF it works on opens **beside** what you are doing, without taking you away from it.

Its searches use JavaScript regular-expression syntax. A slow pattern never freezes the editor: after five seconds the search answers anyway, keeps the matches it had found, and says plainly that the result is incomplete.

**It has the same access to your computer as in your terminal.** It can run programs and read and change files anywhere your account can, and it does so without asking first, because nobody could answer a permission prompt in the panel. It is told to make every change to the vault through this app, which is what puts its edits in your editor live and lets \`Cmd + Z\` undo them.

Your own MCP servers are left out of the panel's runs, and so are your hooks and plugins for Claude Code and OpenCode. Codex has no single switch for its hooks, plugins and apps (including the MCP servers a plugin brings), so those still run there.

### Where chats are kept
The vault holds only a small list of its chats, in a hidden \`.VaultAgent\` folder (hidden from the file tree, search and the graph, as are \`.claude\`, \`.agents\`, \`.codex\` and \`.opencode\` folders at the top of the vault). The conversations themselves are kept by the agent in its own place, the way it keeps your terminal sessions; the agent works from a folder of its own for this vault, under \`~/.bme-agent-sessions\` in your home folder. A \`CLAUDE.md\` or \`AGENTS.md\` at the top of the vault, and skills in \`.claude/skills\` or \`.agents/skills\`, are passed on to the agent as instructions.

### Keeping it up to date
Each time you load the page (once you have connected before, and Chrome still allows the connection), the editor asks VaultAgent whether a newer version has been released. When one has, a small dot appears on the sparkles button (and on the expand-sidebar button while the sidebar is hidden), and the panel says "**VaultAgent X** is available" with an **Update** button. The panel's **⋯** menu also has **Update VaultAgent**, which you can use any time; it is greyed out when you already have the latest version. The version you have is shown at the top of that menu.

One click is all it takes: VaultAgent downloads the new version, checks that it runs on this computer, replaces the old copy and restarts. The panel shows the progress, reconnects by itself and says "Updated to VaultAgent X". Your chats are kept. If a reply is being written, the panel asks first, because updating stops it.

If anything goes wrong, the version you have keeps running and the panel says what happened, with **Try again** and a **Download installer** link: opening the installer replaces the old copy just as well.

VaultAgent versions older than 0.1.3 cannot update themselves. For those, the **⋯** menu keeps **Download installer**: download it and open it once, and later versions update from the panel.

### Turning it off
The panel's **⋯** menu always has **Uninstall VaultAgent** (it works while VaultAgent is connected, even an outdated one, and waits while an update runs): it stops the helper, removes it from your login items and deletes it. Your chats stay. To use the agent again, download the installer from the panel and open it.

If any terminals are open (section 10), updating or uninstalling VaultAgent asks first, because restarting the helper ends their shells.

---

## 10. The Terminal

The terminal button at the bottom of the sidebar — right of the sparkles — or \`\`Ctrl + \` \`\` (Control and the backquote key, on every system, as in VS Code) opens a terminal along the bottom of the editor. It is a real terminal, like the one built into VS Code: everything you can do in your own terminal app works here — running commands, scripts and programs, editors like \`vim\`, \`htop\`, Python and other REPLs, \`ssh\`, \`git\` with its pager, colours, \`Ctrl + C\` and the other control keys.

It is **your own shell, with your own settings**: the same login shell your terminal app opens (zsh, bash, fish, …), with everything your profile sets up — your PATH (Homebrew, nvm, pyenv, conda…), aliases, functions and your prompt theme (oh-my-zsh, Powerlevel10k, Starship…). It **starts in the folder of the file you are looking at** — open \`CS145/a3/sum.rkt\` and the shell is already in \`CS145/a3\`. A new tab (**+**) starts wherever you are *then*, so moving to a file in another folder and pressing **+** gives you a shell there; the tabs you already have stay where they are, since a running shell has its own place. With no file open you get the top of the vault, and if VaultAgent cannot work out where the vault is on disk, your home folder, as before. It is not limited in any way: it can do anything your user account can.

VaultAgent finds the vault by itself — the browser is not allowed to tell it where your folders are, so it looks for the vault's own marker file. If it cannot find it (a vault outside your home folder, or on a network drive), **Settings → Terminal → Vault folder on disk** takes the full path; it checks the folder really is that vault before using it.

It needs **VaultAgent** (see section 9), version 0.2.0 or newer — the same helper the agent uses, with nothing to set up or switch on. If VaultAgent is not installed, or is too old, the terminal shows the same install, connect or update screen as the agent panel. The first click on the terminal button may make Chrome ask whether this site may talk to apps on your computer; choose **Allow**.

### Several terminals
The strip at the top of the terminal holds a tab per shell (\`zsh\`, \`zsh 2\`, …). **+** starts another one (up to ten), clicking a tab switches to it, and the **×** on a tab ends that shell. Hiding the terminal — the **⌄** button, the sidebar button again, or \`\`Ctrl + \` \`\` — keeps every shell running exactly as it was; so does switching vaults, the graph view, or reloading the page, which reconnects to the shells it had (a shell left with no page attached is ended after 30 minutes). Ending the last shell hides the terminal. When a shell exits on its own, its tab says so; press **Enter** to start a new one in its place. If you open the same shell in another browser window, this one's tab says it moved there.

### Size, copy and paste
Drag the terminal's top edge to make it taller or shorter (the editor always keeps some room); double-click the edge to put it back, or focus it and use the up and down arrow keys (with **Shift** for bigger steps). The terminal remembers its height and fits itself to whatever room it has.

- **macOS:** select text and \`Cmd + C\` copies; \`Cmd + V\` pastes; \`Cmd + K\` clears; \`Option + ←/→\` jump by word and \`Cmd + ←/→\` to the start or end of the line. \`Option\` types characters as usual (it is not Meta). Programs that copy to the clipboard themselves (over \`ssh\` or in \`tmux\`, say) reach your real clipboard.
- **Windows and Linux:** \`Ctrl + C\` copies when text is selected (otherwise it interrupts the program, as usual); \`Ctrl + Shift + C\` copies, \`Ctrl + Shift + V\` pastes. \`Ctrl + W\` would close the browser tab, so while you are in the terminal Chrome asks before leaving the page.
- **Right-click** for **Copy**, **Paste**, **Select All**, **Clear**, **New Terminal** and **Kill Terminal** — unless the program running wants the mouse itself (like \`htop\` or \`vim\` with the mouse on); hold **Shift** to get the menu anyway.
- Links in the output open in a new browser tab with \`Cmd\`-click (\`Ctrl\`-click on Windows and Linux).

Inside the terminal, keys belong to the shell: \`Cmd + E\` and the \`Option\`/\`Alt\` tab shortcuts do not reach the editor. \`Cmd + S\`, \`Cmd + N\` and \`\`Ctrl + \` \`\` still work on a Mac.

### Fonts and icons
The terminal uses the font your terminal app is set to — it looks in Ghostty, iTerm2, kitty, Alacritty, WezTerm, Windows Terminal, Terminal and VS Code — when that font is installed. Settings → Terminal lets you choose a font and size instead. The icons that prompt themes draw (Nerd Font symbols) always show, because the editor carries a font of just those symbols for when yours lacks them. The colours follow the editor's light or dark theme.

### macOS: Documents, Desktop and iCloud Drive
macOS protects some folders. The first time a command in the terminal reaches into one of them, macOS asks whether **vaultagent-pty** — the small part of VaultAgent that runs your shells — may access it; choose **Allow**. These permissions are separate from the ones your own terminal app has, and they are kept across VaultAgent updates. To never be asked, give **vaultagent-pty** Full Disk Access once: the terminal offers **Open Settings** and **Show in Finder** for that (drag it into the list, or switch it on), and you can dismiss the offer. If you uninstall VaultAgent and install it again, your permissions still match.

### The agent and the terminal
They are separate: the agent never sees, reads or types into your terminal, and nothing you do in the terminal is sent to it.

---

*End of Guide.*`;
