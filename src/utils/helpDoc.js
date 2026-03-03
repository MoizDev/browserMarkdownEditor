export const HELP_DOC_CONTENT = `# Browser Markdown Editor User Guide

Welcome to your Browser Markdown Editor. This application is a fully offline, local-first markdown editor that operates entirely within your web browser using the native File System Access API. 

Because it operates locally, you retain complete ownership and privacy over your data. There are no servers, no databases, and no cloud syncing happening in the background. Your files remain exclusively on your device.

Here is everything you need to know about using the application.

---

## 1. Vault Management

### What is a Vault?
A "Vault" is simply any folder on your computer that you choose to open with this application. When you click "Open local folder (Vault)", the browser asks for your permission to read and write to that specific directory.

### Security & Permissions
Modern browsers require you to explicitly grant permission every time you open a vault or sometimes when returning to the application after a session. This is a deliberate security feature of the File System Access API to ensure websites cannot silently access your hard drive. 

---

## 2. File Organization & Navigation

### File Tree
The left sidebar displays your vault's folder structure. You can click on any \`.md\` file to open it in the editor.

### Drag and Drop
You can drag and drop files and folders within the file tree to reorganize your vault:
- Drag any item and drop it onto a folder to move it inside that folder.
- Drag any item and drop it onto the empty space in the sidebar (the root level) to move it back to the main vault directory.
- Folders highlight with a purple dashed outline when you hover over them while dragging.

### Creating New Items
Use the "New File" and "New Folder" icons at the top of the sidebar. When creating a new file:
- It will be created in the root vault folder if nothing is selected.
- If you have a file or folder selected, it will be created in the same directory as that selection.
- New files will automatically open and place you in **Edit Mode**.

---

## 3. Editing Modes & Auto-Save

### Edit Mode vs. Read Mode
The application features two distinct viewing modes:
- **Read Mode (Default):** Files open in this mode by default. Markdown syntax is fully rendered and hidden, and the document is locked from accidental edits.
- **Edit Mode:** Clicking the toggle button (or pressing \`Cmd + E\` / \`Ctrl + E\`) switches the editor to Edit Mode. You can now type and edit.

### Live Preview
Even in Edit Mode, the editor uses a "Live Preview" system. Markdown syntax (like bold asterisks or heading hashes) is hidden on lines you are not actively editing. When your cursor moves to a line, the raw syntax is revealed so you can modify it.

### Auto-Save
You do not need to manually save your work. The editor automatically saves your changes to your local hard drive 1 second after you stop typing. You can also manually trigger a save using \`Cmd + S\` or \`Ctrl + S\`.

### Scroll Persistence
When you scroll down a long document, the application remembers your position. If you switch to another file and then come back, the editor will automatically snap back down to exactly where you left off.

---

## 4. Images, Assets, and Trash

### Managing Images
You can seamlessly add images to your markdown notes:
- **Paste:** Simply copy an image to your clipboard and paste it (\`Cmd + V\` / \`Ctrl + V\`) directly into the editor.
- **Drag and Drop:** Drag an image file from your computer and drop it directly onto the text editor.

### The \`.Assets\` Folder
When you paste or drop an image, the application does the following in the background:
1. It automatically creates a hidden folder named \`.Assets\` in the same directory as your active markdown file.
2. It generates a uniquely named image file (e.g., \`Pasted image 20240101120000.png\`).
3. It saves that image into the \`.Assets\` folder.
4. It inserts the markdown code \`![[filename.png]]\` into your note, which natively renders the image.

### Opening Media
If you click on \`.pdf\`, \`.jpg\`, \`.jpeg\`, or \`.png\` files directly within the file tree, they will automatically open in a new browser tab for viewing rather than attempting to load as text.

### The Trash System
To prevent accidental permanent data loss, deleting a file or folder does not erase it from your hard drive. Instead, it moves the item into a hidden \`.Trash\` folder located in the same directory. You can manually recover these files using your computer's native file explorer (Finder or Windows Explorer) if needed.

---

## 5. Markdown Syntax Reference

The editor supports standard Markdown and advanced formatting.

### Headers
# Header 1
## Header 2
### Header 3

### Text Styling
**Bold Text** using double asterisks.
*Italic Text* using single asterisks.
~~Strikethrough~~ using double tildes.
==Highlighted Text== using double equals signs.

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

### Tables
| Syntax | Description |
| ----------- | ----------- |
| Header | Title |
| Paragraph | Text |

---

## 6. LaTeX Math Expressions

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

---

*End of Guide.*`;
