# PdfWorker

[![Deploy to GitHub Pages](https://github.com/USERNAME/PdfWorker/actions/workflows/deploy.yml/badge.svg)](https://github.com/mcbride-clint/PdfWorker/actions/workflows/deploy.yml)

**Live demo:** https://mcbride-clint.github.io/PdfWorker/

---

## What It Does

PdfWorker is a free, privacy-first PDF tool that runs entirely inside your web browser. Upload one or more PDF files across multiple independent document workspaces, rearrange pages, rotate them, remove unwanted pages, merge documents, split out page ranges, or burst them into individual files — then download the result as a PDF or ZIP archive. **Nothing is ever uploaded to a server.** All processing happens locally on your machine using JavaScript.

---

## Features

### Core Operations
- **Upload** — Drop or browse for one or more PDF files; drag PDFs directly onto any document's page grid
- **Encrypted PDFs** — Password-protected files prompt for a password on load; wrong passwords can be retried or the file skipped
- **Multiple Documents** — Work on several PDFs simultaneously, each in its own named pane; download them independently
- **Reorder** — Drag-and-drop page thumbnails to rearrange within a document, or drag pages between documents
- **Rotate** — Click ↻ on any page thumbnail to rotate it 90° clockwise; applies correctly to the downloaded PDF
- **Remove** — Click × on any page thumbnail to delete it; or use the right-click menu for bulk removal
- **Duplicate** — Clone any page via the right-click context menu
- **Multi-select** — Ctrl+click to toggle individual pages, Shift+click to select a range; then rotate or delete all selected pages at once
- **Undo / Redo** — Up to 50 undo/redo steps for all page operations, including multi-page deletions (Ctrl+Z / Ctrl+Y)

### Download Options
- **Merge & Download** — Download all pages in a document as a single merged PDF
- **Split (range)** — Extract a start–end page range as a new PDF
- **Burst** — Save every page as its own individual PDF file
- **ZIP** — Package all pages as individual PDFs inside a single ZIP archive (no sequential browser downloads needed)
- **PDF Metadata** — Set title, author, and subject before any download (Merge, ZIP, Split range)

### Productivity
- **Keyboard shortcuts** — Navigate and edit without touching the mouse (see table below)
- **Right-click context menu** — Rotate, duplicate, remove, bulk-remove before/after, or move a page to another document; actions apply to all selected pages when multiple are selected
- **Inline document naming** — Click the document title to rename it; the name is used in downloaded filenames
- **Session persistence** — Your work is saved automatically in the browser (IndexedDB) and restored when you reopen the page; use **Clear All** to start fresh

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Z` | Undo |
| `Ctrl+Y` or `Ctrl+Shift+Z` | Redo |
| `Delete` or `Backspace` | Remove the selected page(s) |
| `←` / `→` | Move the selected page left / right within its document (single selection only) |
| `Escape` | Deselect all pages / close context menu |
| `Ctrl+click` | Toggle a page in/out of the selection |
| `Shift+click` | Extend the selection to a range within the same document |

> Click a page thumbnail to select it. Multi-select with Ctrl/Shift+click, then use Delete or the right-click menu to operate on all selected pages at once. Shortcuts are disabled when a text input is focused.

---

## Multiple Documents

Create as many document panes as you need:

1. Drop a PDF onto the upload zone or click **+ Add PDFs** — files go into the currently active document (highlighted in blue).
2. Click **+ New Document** to create an empty pane, then drag pages or drop files into it.
3. Drag any page thumbnail to a different document pane to move it there.
4. Right-click a page and choose **Move to…** to send it to another document.
5. Each pane has its own **Download PDF**, **Burst**, **ZIP**, and **Split range** buttons.
6. Rename a document by clicking its title — the name appears in downloaded filenames.

---

## Privacy

All PDF processing runs in your browser using [pdf-lib](https://pdf-lib.js.org/), [PDF.js](https://mozilla.github.io/pdf.js/), and [fflate](https://github.com/101arrowz/fflate). Your files are never sent to any server, and no analytics or tracking is used. The page can be used completely offline once loaded.

---

## Technology Stack

| Library | Version | License | Purpose |
|---|---|---|---|
| [pdf-lib](https://pdf-lib.js.org/) | 1.17.1 | MIT | PDF creation, merge, split, rotate, reorder |
| [PDF.js](https://mozilla.github.io/pdf.js/) | 3.11.174 | Apache 2.0 | Page thumbnail rendering |
| [Bootstrap](https://getbootstrap.com/) | 5.3.3 | MIT | UI styling |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.2 | MIT | ZIP archive creation |

All libraries are bundled locally — no CDN calls, no external dependencies at runtime.

---

## Local Development

No build tools required. Serve the project root over HTTP:

```bash
# Python (most machines have this)
python -m http.server 8080

# Node.js (if you have npx)
npx serve .
```

Then open http://localhost:8080 in your browser.

> **Note:** Opening `index.html` directly as a `file://` URL will not work because PDF.js requires its worker script to be loaded from the same HTTP origin. Use a local server as shown above.

---

## Building / Deploying

There is no build step. The repository itself is the deployable artifact.

### Deploy to GitHub Pages

1. Push this repository to GitHub.
2. Go to **Settings → Pages → Build and deployment**.
3. Set **Source** to **GitHub Actions**.
4. Push a commit to `master` — the [deploy workflow](.github/workflows/deploy.yml) will run automatically and publish the site.

The site will be available at `https://USERNAME.github.io/PdfWorker/` (replace `USERNAME` with your GitHub username).

---

## Browser Support

Requires a modern browser with ES2020 module support and WebAssembly (used internally by PDF.js):

| Browser | Minimum version |
|---|---|
| Chrome / Edge | 80+ |
| Firefox | 75+ |
| Safari | 14+ |

---

## Known Limitations

- **Burst downloads** — Saving each page as its own file triggers multiple browser downloads. Your browser may ask you to allow multiple file downloads. Consider using **ZIP** instead to avoid this.
- **ZIP memory** — The ZIP export holds all pages as Uint8Arrays in memory simultaneously before packaging. Very large documents (100+ pages, large file sizes) may be slow or cause memory pressure; use Burst in that case.
- **Very large files** — PDFs over ~100 MB may be slow to process depending on your device.
- **Session storage limits** — IndexedDB storage quotas vary by browser and device. Very large sessions (many high-resolution PDFs) may not be fully persisted.

---

## License

MIT License — see [LICENSE](LICENSE) for details.

All bundled third-party libraries retain their original licenses (MIT for pdf-lib, Bootstrap, and fflate; Apache 2.0 for PDF.js). See the library files in `js/` and `css/` for their individual license headers.
