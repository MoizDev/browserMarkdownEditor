# Browser Markdown Editor

A powerful, entirely local-first browser-based Markdown editor inspired by Obsidian. Built tightly around the File System Access API, it allows users to manage and edit local Markdown files directly within their web browser, maintaining file structures and directories seamlessly. The application operates solely on your local device without any backend or database requirements, ensuring maximum privacy and data ownership.

## Key Features

- **Local Vault Integration:** Open a local folder as your "Vault" directly from your machine. Any edits made in the browser are instantly reflected in your local file system, and vice versa.
- **Robust Markdown Editing & Live Preview:** Powered by CodeMirror 6, the editor hides markdown syntax as you type and seamlessly renders elements such as headings, lists, tables, bold/italic text, and code blocks inline.
- **Advanced LaTeX Math Support:** Integrated KaTeX rendering allows for both inline mathematical expressions (`$math$`) and block equations (`$$math$$`).
- **File & Folder Management:** Features a built-in file explorer side panel. You can easily create, delete, and rename notes and directories.
- **Drag & Drop Organization:** Organize your vault effortlessly using contextual drag-and-drop to move files and folders into different directories natively within your file tree. Supported across subfolders and directly to the vault root.
- **Integrated Image & Asset Handling:** Automatically saves pasted or dragged images to a hidden `.Assets` folder within the respective directory. Native rendering of standard images and PDFs directly within the markdown preview.
- **Session Persistence:** Remembers your open vault, expanded file tree directories, cursor position, last active note, and application settings using standard client cache (localStorage).
- **Systematic Settings Panel:** A native settings modal allows adjustments for editor text width (padding), editor font size, and file tree font size, complete with a "Reset to Defaults" option.
- **Theme Support:** Clean, intuitive toggle between meticulously designed light and dark themes.

## Technical Architecture

The architecture is deliberately chosen to be lightweight and exclusively front-end focused.

### Core Technologies
- **React 18:** Functional components, Context API, and Hooks handle complex UI state logic.
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
- Deleted items are structured to avoid destructive irreversible permanent OS actions, moving natively to parallel relative `.Trash` container directories.
