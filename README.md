# PdfWorker

[![Deploy to GitHub Pages](https://github.com/USERNAME/PdfWorker/actions/workflows/deploy.yml/badge.svg)](https://github.com/USERNAME/PdfWorker/actions/workflows/deploy.yml)

**Live demo:** https://USERNAME.github.io/PdfWorker/

> Replace `USERNAME` above with your GitHub username after you push the repository.

---

## What It Does

PdfWorker is a free, privacy-first PDF tool that runs entirely inside your web browser. Upload one or more PDF files, rearrange their pages, remove unwanted pages, merge them into a single document, or split out a page range — then download the result. **Nothing is ever uploaded to a server.** All processing happens locally on your machine using JavaScript.

---

## Features

- **Upload** — Drop or browse for one or more PDF files
- **Reorder** — Drag-and-drop page thumbnails to rearrange in any order
- **Remove** — Click &times; on any page thumbnail to delete it from the working set
- **Merge** — Pages from multiple uploaded PDFs are combined into one working set; download them all as a single PDF
- **Split (range)** — Enter a start and end page number to extract just those pages as a new PDF
- **Burst** — Download every page as its own individual PDF file (useful for separating scanned documents)
- **Download** — Saves the result directly to your computer

---

## Privacy

All PDF processing runs in your browser using [pdf-lib](https://pdf-lib.js.org/) and [PDF.js](https://mozilla.github.io/pdf.js/). Your files are never sent to any server, and no analytics or tracking is used. The page can be used completely offline once loaded.

---

## Technology Stack

| Library | Version | License | Purpose |
|---|---|---|---|
| [pdf-lib](https://pdf-lib.js.org/) | 1.17.1 | MIT | PDF creation, merge, split, reorder |
| [PDF.js](https://mozilla.github.io/pdf.js/) | 3.11.174 | Apache 2.0 | Page thumbnail rendering |
| [Bootstrap](https://getbootstrap.com/) | 5.3.3 | MIT | UI styling |

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
4. Push a commit to `main` — the [deploy workflow](.github/workflows/deploy.yml) will run automatically and publish the site.

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

- **Encrypted PDFs** — Password-protected PDFs are not supported and will show an error on load.
- **Burst downloads** — Saving each page as its own file triggers multiple browser downloads. Your browser may ask you to allow multiple file downloads; check the address bar if files don't appear.
- **Very large files** — PDFs over ~100 MB may be slow to process depending on your device.
- **No undo** — Changes to the page order are not undoable; click "Clear All" and re-upload to start over.

---

## License

MIT License — see [LICENSE](LICENSE) for details.

All bundled third-party libraries retain their original licenses (MIT for pdf-lib and Bootstrap; Apache 2.0 for PDF.js). See the library files in `js/` and `css/` for their individual license headers.
