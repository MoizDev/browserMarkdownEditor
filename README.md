# Browser Markdown Editor

A powerful, entirely local-first browser-based Markdown editor inspired by Obsidian. Built tightly around the File System Access API, it allows users to manage and edit local Markdown files directly within their web browser, maintaining file structures and directories seamlessly. The application operates solely on your local device without any backend or database requirements, ensuring maximum privacy and data ownership.

## Key Features

- **Local Vault Integration:** Open a local folder as your "Vault" directly from your machine. Any edits made in the browser are instantly reflected in your local file system, and vice versa.
- **Robust Markdown Editing & Live Preview:** Powered by CodeMirror 6, the editor hides markdown syntax as you type and seamlessly renders elements such as headings, lists, tables, bold/italic text, and code blocks inline.
- **Advanced LaTeX Math Support:** Integrated KaTeX rendering allows for both inline mathematical expressions (`$math$`) and block equations (`$$math$$`).
- **File & Folder Management:** Features a built-in file explorer side panel. You can easily create, delete, and rename notes and directories.
- **Drag & Drop Organization:** Organize your vault effortlessly using contextual drag-and-drop to move files and folders into different directories natively within your file tree. Supported across subfolders and directly to the vault root.
- **Integrated Image & Asset Handling:** Automatically saves pasted images to a hidden `.Assets` folder in the same directory as the note, and looks for them nowhere else — so a folder carries its own pictures and stays self-contained wherever it is moved. Delete a picture and its file is retired to that folder's `.Garbage` (kept if another note in the folder still shows it, and reclaimed on undo). Native rendering of standard images and PDFs directly within the markdown preview.
- **Pictures Behave Like Pictures:** An embedded image is an object, not a piece of syntax — it never turns back into `![[file.png]]` under the cursor. Click it while editing to select it, then resize it with the `+`/`−` buttons on its corner or remove it with the bin (or `Backspace`), confirmation and undo included. The file on disk stays plain Markdown throughout.
- **Tables Behave Like Tables:** A rendered table is an object too. Click a cell and type in it — the table never collapses back into pipes and dashes under the cursor. `Tab`, `Shift + Tab` and `Enter` walk the cells, two `+` chips at the corners append a row or a column, and right-clicking a cell inserts or deletes rows and columns. Every edit writes back the narrowest change it can, so your alignment colons, your `\|` escapes and the padding you lined up by hand all survive untouched; the file stays ordinary GFM pipe markdown that Obsidian or GitHub reads the same way. New tables come from a Google-Docs-style matrix picker behind *Insert table…*, or from simply typing one.
- **The App's Own Right-Click Menu:** Right-clicking a note gives Cut/Copy/Paste/Select all and *Insert table…*; right-clicking a table cell gives the table's own row and column commands; right-clicking the file tree gives New note, New folder, Rename and Move to Trash, on the row or on the empty space below it. Unavailable rows stay on the menu and say why rather than disappearing. A drawing keeps tldraw's own menu and a PDF keeps the browser's.
- **Split-Screen Tabs:** Drag any tab out of the strip and drop it onto the page you are reading to put the two side by side in one tab — up to five documents at once, in whatever mix you like (two notes, a note beside a PDF, a whiteboard beside the notes you are taking from it). A purple outline shows which half of the page the tab will take. Every pane is a real editor with its own undo history; a pane's header moves it back to its own tab or closes just that document. Drag the line between two panes to give one of them more room and its neighbour less — only those two move — or double-click that line to even every pane up again.
- **Session Persistence:** Remembers your open vault, expanded file tree directories, cursor position, last active note, how your tabs were split and how wide you left each pane, and application settings using standard client cache (localStorage).
- **Systematic Settings Panel:** A native settings modal allows adjustments for editor text width (padding), editor font size, and file tree font size, complete with a "Reset to Defaults" option.
- **Theme Support:** Clean, intuitive toggle between meticulously designed light and dark themes.

## Technical Architecture

The architecture is deliberately chosen to be lightweight and exclusively front-end focused.

### Core Technologies
- **React 19:** Functional components, Context API, and Hooks handle complex UI state logic.
- **Vite:** Next-generation frontend tooling handling rapid Hot Module Replacement (HMR) and optimized build processes.
- **CodeMirror 6:** An extensible framework providing the foundation for our dynamic text editing experience. It is heavily customized with CodeMirror Lezer extensions and syntax plugins to support real-time "live preview" overlays.
- **KaTeX:** Efficient and complete mathematical typesetting.

### How It Works

**File System Access API Interaction**
The lifeblood of the application is the `useFileSystem` hook which abstracts the experimental browser capability:
- Navigating native folders via Native File/Directory Pickers.
- Saving buffers and reading file streams through OS dialogs.
- Constructing a predictable, reactive file tree model (`fileTree` structure) that maps out nodes and child objects mimicking your actual system.

**The Editor Implementation**
The editor component leverages CodeMirror's state structure to provide split editing paradigms:
- **Editor Mode vs Reading Mode:** In reading mode, it acts strictly as a static document. In editing mode, active lines show their raw markdown, while inactive text collapses into processed stylings.
- **Decorators and Widgets:** Utilizing CodeMirror decorators to parse the Lezer syntax tree, selectively hiding tokens and seamlessly injecting CSS styling mimicking standard block elements (indented bullet points, styled quotes, horizontal rules).
- **Paste/Drop Listeners:** Implemented at the CodeMirror extension level to intercept images natively. It validates the blob, generates unique hash-based filenames, drops it into a sibling-level `.Assets` bucket, and embeds the relative image tag inside the editor cursor position.

**Styling Approach**
- **Vanilla CSS:** Entirely reliant on functional raw CSS leveraging root CSS Variables heavily, thus circumventing any preprocessors or bloated utility frameworks. This provides fine-grained control for layout algorithms such as flexbox layouts across the explorer and dynamic responsive padding calculations.
- **Design Alignment:** Focused deliberately on achieving standard modern note-taking aesthetics, specifically mimicking features found in premium apps like Obsidian.

## Running the Application

### Prerequisites
- Node.js
- A Chromium-based browser or supported variant as full, unrestrained File System Access API is strictly required for application functionality.

### Development Setup
1. Clone the repository to your local machine.
2. Navigate to the project directory:
   ```bash
   cd browserMarkdownEditor
   ```
3. Install the required dependencies:
   ```bash
   npm install
   ```
4. Start the development server:
   ```bash
   npm run dev
   ```
5. Open the displayed local link in your browser.

### Building for Production
To generate a streamlined, minified set of static assets optimized for standard web hosting environments:
```bash
npm run build
```
This generates the relevant application bundle dynamically inside the `dist/` directory, which can subsequently be deployed to platforms like Vercel, Netlify, or standard Apache/Nginx web servers.

## Future Context & Limitations
- The underlying architecture heavily depends on browser edge permissions. Users must initially and explicitly grant OS-level prompt access to their chosen folder.
- Deleted items are structured to avoid destructive irreversible permanent OS actions, moving natively to parallel relative `.Garbage` container directories.
