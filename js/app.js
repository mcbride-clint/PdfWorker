/**
 * PdfWorker — app.js
 * 100% client-side PDF manipulation.
 * Dependencies: pdf-lib (MIT), PDF.js (Apache 2.0) — both bundled locally.
 *
 * Storage strategy: source PDF bytes are kept as immutable Blobs.
 * Blobs cannot be transferred or neutered by Worker postMessage.
 * Each blob.arrayBuffer() call returns a fresh independent ArrayBuffer,
 * so no library can corrupt the stored data.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   id: string,
 *   sourceFileName: string,
 *   sourcePdfBlob: Blob,
 *   originalPageIndex: number,
 *   thumbnailDataUrl: string|null
 * }} PageItem
 */

/** @type {PageItem[]} */
let pages = [];

/** @type {Array<{id:string, name:string, pageCount:number}>} */
let loadedDocs = [];

// Drag state
let dragSourceIndex = -1;

// ---------------------------------------------------------------------------
// DOM refs (resolved once on DOMContentLoaded)
// ---------------------------------------------------------------------------

let uploadZone, fileInput, mainContent;
let thumbnailGrid, fileList, pageCountLabel;
let btnDownload, btnSplit, btnBurst, btnClear, btnAddMore;
let splitFrom, splitTo;
let toastEl, toastMsg;
let bsToast;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  uploadZone     = document.getElementById('upload-zone');
  fileInput      = document.getElementById('file-input');
  mainContent    = document.getElementById('main-content');
  thumbnailGrid  = document.getElementById('thumbnail-grid');
  fileList       = document.getElementById('file-list');
  pageCountLabel = document.getElementById('page-count-label');
  btnDownload    = document.getElementById('btn-download');
  btnSplit       = document.getElementById('btn-split');
  btnBurst       = document.getElementById('btn-burst');
  btnClear       = document.getElementById('btn-clear');
  btnAddMore     = document.getElementById('btn-add-more');
  splitFrom      = document.getElementById('split-from');
  splitTo        = document.getElementById('split-to');
  toastEl        = document.getElementById('toast');
  toastMsg       = document.getElementById('toast-msg');

  bsToast = {
    show(msg, variant = 'secondary') {
      toastMsg.textContent = msg;
      toastEl.className = `toast align-items-center text-bg-${variant} border-0 show`;
      setTimeout(() => toastEl.classList.remove('show'), 3500);
    }
  };

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFiles(fileInput.files);
  });

  uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
  uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  btnAddMore.addEventListener('click', () => fileInput.click());
  btnDownload.addEventListener('click', handleDownload);
  btnSplit.addEventListener('click', handleSplitRange);
  btnBurst.addEventListener('click', handleBurst);
  btnClear.addEventListener('click', handleClearAll);

  document.getElementById('btn-split-toggle').addEventListener('click', () => {
    const group = document.getElementById('split-range-group');
    const hidden = group.classList.toggle('d-none');
    document.getElementById('btn-split-toggle').textContent = hidden ? 'Split range…' : 'Hide split';
  });
});

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

async function handleFiles(fileList_) {
  const files = Array.from(fileList_).filter(
    f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
  );
  if (!files.length) { bsToast.show('Please select PDF files only.', 'danger'); return; }

  for (const file of files) {
    try {
      // Store source bytes as an immutable Blob.
      // Blobs cannot be transferred or neutered by Web Workers.
      // blob.arrayBuffer() always returns a fresh independent copy.
      const blob = new Blob([await file.arrayBuffer()], { type: 'application/pdf' });

      // Load a temporary copy just to count pages — never touch the stored blob directly
      const countBytes = new Uint8Array(await blob.arrayBuffer());
      const tempDoc = await PDFLib.PDFDocument.load(countBytes, { ignoreEncryption: true });
      const pageCount = tempDoc.getPageCount();

      loadedDocs.push({ id: crypto.randomUUID(), name: file.name, pageCount });

      for (let i = 0; i < pageCount; i++) {
        pages.push({
          id: crypto.randomUUID(),
          sourceFileName: file.name,
          sourcePdfBlob: blob,       // shared reference — the Blob itself is immutable
          originalPageIndex: i,
          thumbnailDataUrl: null,
        });
      }
    } catch (err) {
      bsToast.show(`Could not load "${file.name}": ${err.message}`, 'danger');
    }
  }

  fileInput.value = '';
  renderAll();
  renderThumbnailsProgressively();
}

// ---------------------------------------------------------------------------
// PDF operations
// ---------------------------------------------------------------------------

/**
 * Load a PDFDocument from a Blob, returning a fresh parse each call.
 * @param {Blob} blob
 * @returns {Promise<PDFLib.PDFDocument>}
 */
async function loadDocFromBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
}

/**
 * Build a merged PDF from an ordered subset of pages.
 * Each unique source Blob is loaded only once per call.
 * @param {PageItem[]} subset
 * @returns {Promise<Uint8Array>}
 */
async function buildPdf(subset) {
  const result = await PDFLib.PDFDocument.create();

  // Cache: Blob reference → loaded PDFDocument (avoids re-parsing the same source)
  const srcCache = new Map();

  for (const p of subset) {
    let src = srcCache.get(p.sourcePdfBlob);
    if (!src) {
      src = await loadDocFromBlob(p.sourcePdfBlob);
      srcCache.set(p.sourcePdfBlob, src);
    }
    const [copied] = await result.copyPages(src, [p.originalPageIndex]);
    result.addPage(copied);
  }

  return result.save();
}

/**
 * Trigger a browser file download.
 * @param {Uint8Array} bytes
 * @param {string} filename
 */
function downloadPdf(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Thumbnail rendering
// ---------------------------------------------------------------------------

/**
 * Progressively render thumbnails for all pages that don't have one yet.
 * Pages from the same source PDF share a single PDF.js document load.
 */
async function renderThumbnailsProgressively() {
  // Group pending pages by source Blob so each PDF is opened only once
  const groups = new Map();
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].thumbnailDataUrl) continue;
    const blob = pages[i].sourcePdfBlob;
    if (!groups.has(blob)) groups.set(blob, []);
    groups.get(blob).push({ page: pages[i], index: i });
  }

  for (const [blob, entries] of groups) {
    // Fresh bytes for PDF.js — blob.arrayBuffer() is always an independent copy
    const pdfBytes = new Uint8Array(await blob.arrayBuffer());
    const pdfDoc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;

    for (const { page, index } of entries) {
      try {
        page.thumbnailDataUrl = await renderPageThumbnail(pdfDoc, page.originalPageIndex + 1);
      } catch {
        page.thumbnailDataUrl = null;
      }

      // Update just this card without re-rendering the whole grid
      const imgArea = thumbnailGrid.querySelector(`[data-id="${page.id}"] .thumb-img`);
      if (imgArea) {
        if (page.thumbnailDataUrl) {
          imgArea.innerHTML = '';
          const img = document.createElement('img');
          img.src = page.thumbnailDataUrl;
          img.alt = `Page ${index + 1}`;
          imgArea.appendChild(img);
        } else {
          imgArea.innerHTML = '<div class="thumb-placeholder thumb-placeholder--error">PDF</div>';
        }
      }
    }

    pdfDoc.destroy();
  }
}

/**
 * Render one page from an already-open PDF.js document to a PNG data URL.
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdfDoc
 * @param {number} pageNumber 1-based
 * @param {number} width target width in px
 * @returns {Promise<string>} PNG data URL
 */
async function renderPageThumbnail(pdfDoc, pageNumber, width = 160) {
  const page = await pdfDoc.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1.0 });
  const scale = width / baseViewport.width;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);

  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  page.cleanup();
  return canvas.toDataURL('image/png');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  const hasPages = pages.length > 0;
  uploadZone.classList.toggle('compact', hasPages);
  mainContent.classList.toggle('d-none', !hasPages);
  renderFileList();
  renderGrid();
  updatePageCountLabel();
  updateSplitInputBounds();
}

function renderFileList() {
  fileList.innerHTML = '';
  for (const doc of loadedDocs) {
    const li = document.createElement('li');
    li.className = 'file-list-item d-flex align-items-start justify-content-between gap-2 mb-1';
    li.innerHTML = `
      <span class="file-item-name">${escHtml(doc.name)}</span>
      <span class="badge bg-secondary flex-shrink-0">${doc.pageCount}</span>
    `;
    fileList.appendChild(li);
  }
}

function renderGrid() {
  thumbnailGrid.innerHTML = '';
  pages.forEach((page, index) => thumbnailGrid.appendChild(createCard(page, index)));
}

function createCard(page, index) {
  const card = document.createElement('div');
  card.className = 'thumb-card';
  card.setAttribute('draggable', 'true');
  card.dataset.index = index;
  card.dataset.id = page.id;

  const imgArea = document.createElement('div');
  imgArea.className = 'thumb-img';
  if (page.thumbnailDataUrl) {
    const img = document.createElement('img');
    img.src = page.thumbnailDataUrl;
    img.alt = `Page ${index + 1}`;
    imgArea.appendChild(img);
  } else {
    imgArea.innerHTML = `<div class="thumb-placeholder">
      <div class="spinner-border spinner-border-sm text-secondary" role="status"></div>
    </div>`;
  }

  const footer = document.createElement('div');
  footer.className = 'thumb-footer';
  footer.innerHTML = `
    <span class="thumb-num">${index + 1}</span>
    <span class="thumb-name" title="${escHtml(page.sourceFileName)}">${escHtml(page.sourceFileName)}</span>
    <button class="btn-remove" title="Remove this page" data-id="${page.id}">&times;</button>
  `;

  card.appendChild(imgArea);
  card.appendChild(footer);

  // Drag-and-drop reorder
  card.addEventListener('dragstart', e => {
    dragSourceIndex = index;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.thumb-card').forEach(c => c.classList.remove('drag-over-card'));
    dragSourceIndex = -1;
  });
  card.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragSourceIndex !== index) card.classList.add('drag-over-card');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over-card'));
  card.addEventListener('drop', e => {
    e.preventDefault();
    card.classList.remove('drag-over-card');
    if (dragSourceIndex >= 0 && dragSourceIndex !== index) {
      movePage(dragSourceIndex, index);
      renderAll();
    }
  });

  footer.querySelector('.btn-remove').addEventListener('click', () => {
    removePage(page.id);
    renderAll();
  });

  return card;
}

function updatePageCountLabel() {
  pageCountLabel.textContent = `${pages.length} page${pages.length !== 1 ? 's' : ''} in working set`;
}

function updateSplitInputBounds() {
  const max = pages.length;
  splitFrom.max = max;
  splitTo.max = max;
  if (+splitFrom.value > max) splitFrom.value = '';
  if (+splitTo.value > max) splitTo.value = '';
}

// ---------------------------------------------------------------------------
// State mutations
// ---------------------------------------------------------------------------

function removePage(id) {
  pages = pages.filter(p => p.id !== id);
  loadedDocs = loadedDocs.filter(doc => pages.some(p => p.sourceFileName === doc.name));
}

function movePage(fromIndex, toIndex) {
  const [item] = pages.splice(fromIndex, 1);
  pages.splice(toIndex, 0, item);
}

function handleClearAll() {
  pages = [];
  loadedDocs = [];
  uploadZone.classList.remove('compact');
  mainContent.classList.add('d-none');
  thumbnailGrid.innerHTML = '';
  fileList.innerHTML = '';
}

// ---------------------------------------------------------------------------
// Toolbar handlers
// ---------------------------------------------------------------------------

async function handleDownload() {
  if (!pages.length) return;
  setButtonBusy(btnDownload, 'Building…');
  try {
    const bytes = await buildPdf(pages);
    downloadPdf(bytes, 'pdfworker-output.pdf');
    bsToast.show(`Downloaded ${pages.length}-page PDF.`, 'success');
  } catch (err) {
    bsToast.show(`Error: ${err.message}`, 'danger');
  } finally {
    restoreDownloadButton();
  }
}

async function handleSplitRange() {
  const from = parseInt(splitFrom.value, 10);
  const to   = parseInt(splitTo.value,   10);
  if (isNaN(from) || isNaN(to)) { bsToast.show('Enter a page range first.', 'warning'); return; }
  if (from < 1 || to > pages.length || from > to) {
    bsToast.show(`Range must be between 1 and ${pages.length}.`, 'warning');
    return;
  }
  setButtonBusy(btnSplit, 'Extracting…');
  try {
    const bytes = await buildPdf(pages.slice(from - 1, to));
    downloadPdf(bytes, `pdfworker-pages-${from}-to-${to}.pdf`);
    bsToast.show(`Extracted pages ${from}–${to}.`, 'success');
  } catch (err) {
    bsToast.show(`Error: ${err.message}`, 'danger');
  } finally {
    btnSplit.disabled = false;
    btnSplit.textContent = 'Extract';
  }
}

async function handleBurst() {
  if (!pages.length) return;
  if (pages.length > 20 && !confirm(
    `This will download ${pages.length} individual PDF files. Your browser may ask you to allow multiple downloads. Continue?`
  )) return;

  setButtonBusy(btnBurst, 'Bursting…');
  try {
    for (let i = 0; i < pages.length; i++) {
      const bytes = await buildPdf([pages[i]]);
      downloadPdf(bytes, `pdfworker-page-${String(i + 1).padStart(3, '0')}.pdf`);
      if (i < pages.length - 1) await delay(120);
    }
    bsToast.show(`Burst complete — ${pages.length} files downloaded.`, 'success');
  } catch (err) {
    bsToast.show(`Error: ${err.message}`, 'danger');
  } finally {
    btnBurst.disabled = false;
    btnBurst.textContent = 'Burst (1 PDF/page)';
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function setButtonBusy(btn, label) {
  btn.disabled = true;
  btn.textContent = label;
}

function restoreDownloadButton() {
  btnDownload.disabled = false;
  btnDownload.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" class="me-1" viewBox="0 0 16 16">
      <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
      <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
    </svg>
    Download PDF`;
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
