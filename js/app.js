/**
 * PdfWorker — app.js
 * 100% client-side PDF manipulation.
 * Dependencies: pdf-lib (MIT), PDF.js (Apache 2.0), fflate (MIT) — all bundled locally.
 *
 * Storage strategy: source PDF bytes are kept as immutable Blobs.
 * Each blob.arrayBuffer() call returns a fresh independent ArrayBuffer,
 * so no library can corrupt the stored data.
 */

// ---------------------------------------------------------------------------
// Typedefs
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   id: string,
 *   sourceFileName: string,
 *   sourcePdfBlob: Blob,
 *   originalPageIndex: number,
 *   thumbnailDataUrl: string|null,
 *   rotation: number
 * }} PageItem
 *
 * @typedef {{ id: string, name: string, pages: PageItem[] }} DocItem
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {DocItem[]} */
let documents = [];

/** @type {string|null} */
let activeDocId = null;

/** @type {{docId:string|null, pageIndex:number}} */
let dragState = { docId: null, pageIndex: -1 };

/** @type {Set<string>} */
let selectedPageIds = new Set();

/** @type {string|null} Last clicked page id — anchor for Shift+click range selection. */
let lastSelectedId = null;

/** @type {{docId:string, pageIndex:number}|null} */
let contextTarget = null;

// Undo/redo history — index 0 = empty initial state
/** @type {Array<DocItem[]>} */
let history = [[]];
let historyIndex = 0;
const HISTORY_LIMIT = 50;

// Download SVG icon (reused in createDocPane and restore)
const DL_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" class="me-1" viewBox="0 0 16 16"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/></svg>`;

// ---------------------------------------------------------------------------
// DOM refs (resolved on DOMContentLoaded)
// ---------------------------------------------------------------------------

let uploadZone, fileInput, mainContent, documentsContainer;
let btnAddPdfs, btnNewDoc, btnUndo, btnRedo, btnClearAll;
let toastEl, toastMsg, bsToast;
let contextMenu, contextMoveSection, contextMoveTargets;

/** @type {IDBDatabase|null} IndexedDB handle (null if unavailable) */
let db = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  uploadZone         = document.getElementById('upload-zone');
  fileInput          = document.getElementById('file-input');
  mainContent        = document.getElementById('main-content');
  documentsContainer = document.getElementById('documents-container');
  btnAddPdfs         = document.getElementById('btn-add-pdfs');
  btnNewDoc          = document.getElementById('btn-new-doc');
  btnUndo            = document.getElementById('btn-undo');
  btnRedo            = document.getElementById('btn-redo');
  btnClearAll        = document.getElementById('btn-clear-all');
  toastEl            = document.getElementById('toast');
  toastMsg           = document.getElementById('toast-msg');
  contextMenu        = document.getElementById('context-menu');
  contextMoveSection = document.getElementById('context-menu-move-section');
  contextMoveTargets = document.getElementById('context-menu-move-targets');

  bsToast = {
    show(msg, variant = 'secondary') {
      toastMsg.textContent = msg;
      toastEl.className = `toast align-items-center text-bg-${variant} border-0 show`;
      setTimeout(() => toastEl.classList.remove('show'), 3500);
    }
  };

  // IndexedDB — restore previous session
  db = await openDb().catch(err => { console.warn('IndexedDB unavailable:', err); return null; });
  if (db) await restoreState().catch(console.error);

  // Upload zone
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFiles(fileInput.files);
  });
  uploadZone.addEventListener('dragover', e => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
  });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
  uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  // Global toolbar
  btnAddPdfs.addEventListener('click', () => fileInput.click());
  btnNewDoc.addEventListener('click', handleNewDoc);
  btnUndo.addEventListener('click', undo);
  btnRedo.addEventListener('click', redo);
  btnClearAll.addEventListener('click', handleClearAll);

  // Preview dialog — revoke blob URL on close to free memory
  const previewDialog = document.getElementById('previewDialog');
  const closePreview = () => {
    const frame = document.getElementById('previewFrame');
    URL.revokeObjectURL(frame.src);
    frame.src = '';
    previewDialog.close();
  };
  document.getElementById('previewCloseBtn').addEventListener('click', closePreview);
  previewDialog.addEventListener('cancel', closePreview);

  // Context menu — hide on outside click or scroll
  document.addEventListener('click', e => {
    if (!contextMenu.contains(e.target)) hideContextMenu();
  });
  document.addEventListener('scroll', hideContextMenu, true);

  // Context menu action dispatch ([data-action] items bubble to the menu element)
  contextMenu.addEventListener('click', e => {
    e.stopPropagation();
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action && contextTarget) handleContextAction(action);
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyDown);

  updateUndoRedoButtons();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDoc(docId) {
  return documents.find(d => d.id === docId) ?? null;
}

function getAllPages() {
  return documents.flatMap(d => d.pages);
}

/** Returns {docId, index} for a page ID, or null if not found. */
function findPageLocation(pageId) {
  for (const doc of documents) {
    const index = doc.pages.findIndex(p => p.id === pageId);
    if (index !== -1) return { docId: doc.id, index };
  }
  return null;
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

function setButtonBusy(btn, label) {
  btn.disabled = true;
  btn.textContent = label;
}

// ---------------------------------------------------------------------------
// History / Undo / Redo
// ---------------------------------------------------------------------------

/**
 * Snapshot current state before a mutation.
 * PageItems are treated as immutable objects — only arrays are copied.
 */
function saveHistory() {
  history = history.slice(0, historyIndex + 1);
  history.push(documents.map(doc => ({ ...doc, pages: [...doc.pages] })));
  if (history.length > HISTORY_LIMIT) history.shift();
  else historyIndex++;
  updateUndoRedoButtons();
  persistState().catch(console.error);
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex--;
  restoreFromHistory();
}

function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  restoreFromHistory();
}

function restoreFromHistory() {
  documents = history[historyIndex].map(d => ({ ...d, pages: [...d.pages] }));
  if (!documents.find(d => d.id === activeDocId)) {
    activeDocId = documents[0]?.id ?? null;
  }
  renderAll();
  renderThumbnailsProgressively();
  updateUndoRedoButtons();
  persistState().catch(console.error);
}

function updateUndoRedoButtons() {
  btnUndo.disabled = historyIndex <= 0;
  btnRedo.disabled = historyIndex >= history.length - 1;
}

// ---------------------------------------------------------------------------
// Document management
// ---------------------------------------------------------------------------

/** Create a new DocItem and append it to documents[]. */
function createDoc(name = null) {
  const doc = {
    id: crypto.randomUUID(),
    name: name ?? `Document ${documents.length + 1}`,
    pages: [],
  };
  documents.push(doc);
  return doc;
}

function handleNewDoc() {
  const doc = createDoc();
  activeDocId = doc.id;
  saveHistory();
  renderAll();
}

function removeDoc(docId) {
  const doc = getDoc(docId);
  if (!doc) return;
  if (doc.pages.length > 0 && !confirm(`Remove "${doc.name}" and all its pages?`)) return;
  documents = documents.filter(d => d.id !== docId);
  if (activeDocId === docId) activeDocId = documents[0]?.id ?? null;
  for (const id of [...selectedPageIds]) {
    if (!findPageLocation(id)) selectedPageIds.delete(id);
  }
  saveHistory();
  renderAll();
}

function setActiveDoc(docId) {
  activeDocId = docId;
  document.querySelectorAll('.doc-pane').forEach(p => {
    p.classList.toggle('doc-pane--active', p.dataset.docId === docId);
  });
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

/**
 * Load PDF files into a document.
 * @param {FileList} fileList_
 * @param {string|null} targetDocId  If null, uses activeDocId or creates a new doc.
 */
async function handleFiles(fileList_, targetDocId = null) {
  const files = Array.from(fileList_).filter(
    f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
  );
  if (!files.length) { bsToast.show('Please select PDF files only.', 'danger'); return; }

  // Resolve target document
  let doc = targetDocId ? getDoc(targetDocId) : (activeDocId ? getDoc(activeDocId) : null);
  if (!doc) {
    doc = createDoc();
    activeDocId = doc.id;
  }

  for (const file of files) {
    try {
      const blob = new Blob([await file.arrayBuffer()], { type: 'application/pdf' });
      const countBytes = new Uint8Array(await blob.arrayBuffer());

      // Try loading without a password first
      let tempDoc;
      try {
        tempDoc = await PDFLib.PDFDocument.load(countBytes);
      } catch (loadErr) {
        const isEncrypted = /encrypt|password/i.test(loadErr.message);
        if (!isEncrypted) throw loadErr;

        // Prompt for password, retrying until correct or user skips
        let unlocked = false;
        while (!unlocked) {
          let password;
          try {
            password = await promptForPassword(file.name);
          } catch {
            // User skipped the file
            bsToast.show(`Skipped "${file.name}".`, 'warning');
            break;
          }
          try {
            tempDoc = await PDFLib.PDFDocument.load(countBytes, { password });
            unlocked = true;
          } catch {
            // Wrong password — show error indicator before the dialog re-opens next iteration
            document.getElementById('passwordError').style.display = '';
          }
        }
        if (!unlocked) continue;
      }

      const pageCount = tempDoc.getPageCount();
      for (let i = 0; i < pageCount; i++) {
        doc.pages.push({
          id: crypto.randomUUID(),
          sourceFileName: file.name,
          sourcePdfBlob: blob,
          originalPageIndex: i,
          thumbnailDataUrl: null,
          rotation: 0,
        });
      }
    } catch (err) {
      bsToast.show(`Could not load "${file.name}": ${err.message}`, 'danger');
    }
  }

  fileInput.value = '';
  saveHistory();
  renderAll();
  renderThumbnailsProgressively();
}

// ---------------------------------------------------------------------------
// PDF operations
// ---------------------------------------------------------------------------

/** Parse a PDF from a Blob — returns a fresh PDFDocument each call. */
async function loadDocFromBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
}

/**
 * Build a merged PDF from an ordered subset of PageItems.
 * Caches source PDFDocuments by Blob to avoid re-parsing.
 * Applies per-page rotation via pdf-lib.
 * @param {PageItem[]} subset
 * @param {{ title?: string, author?: string, subject?: string }} [meta]
 * @returns {Promise<Uint8Array>}
 */
async function buildPdf(subset, meta = {}) {
  const result = await PDFLib.PDFDocument.create();
  if (meta.title)   result.setTitle(meta.title);
  if (meta.author)  result.setAuthor(meta.author);
  if (meta.subject) result.setSubject(meta.subject);
  result.setProducer('PdfWorker');
  result.setCreationDate(new Date());
  const srcCache = new Map();

  for (const p of subset) {
    let src = srcCache.get(p.sourcePdfBlob);
    if (!src) {
      src = await loadDocFromBlob(p.sourcePdfBlob);
      srcCache.set(p.sourcePdfBlob, src);
    }
    const [copied] = await result.copyPages(src, [p.originalPageIndex]);
    result.addPage(copied);

    if (p.rotation !== 0) {
      const addedPage = result.getPage(result.getPageCount() - 1);
      addedPage.setRotation(PDFLib.degrees(p.rotation));
    }
  }

  return result.save();
}

/** Trigger a browser download for a PDF Uint8Array. */
function downloadPdf(bytes, filename) {
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), filename);
}

/** Trigger a browser download for any Blob. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Open the assembled PDF in a preview modal (uses the browser's native viewer). */
async function previewDoc(docId) {
  const doc = getDoc(docId);
  if (!doc || doc.pages.length === 0) return;
  bsToast.show('Building preview…', 'secondary');
  try {
    const bytes = await buildPdf(doc.pages);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    document.getElementById('previewModalLabel').textContent = doc.name || 'Preview';
    document.getElementById('previewFrame').src = url;
    document.getElementById('previewDialog').showModal();
  } catch (e) {
    bsToast.show('Preview failed: ' + e.message, 'danger');
  }
}

/** Sanitise a doc name for use in filenames. */
function safeFilename(name) {
  return name.replace(/\.pdf$/i, '').replace(/[/\\?%*:|"<>]/g, '-') || 'pdfworker';
}

// ---------------------------------------------------------------------------
// Thumbnail rendering
// ---------------------------------------------------------------------------

/**
 * Progressively render thumbnails for all pages that don't have one yet.
 * Groups pages by source Blob so each source PDF is opened only once.
 */
async function renderThumbnailsProgressively() {
  const groups = new Map();
  for (const page of getAllPages()) {
    if (page.thumbnailDataUrl) continue;
    const blob = page.sourcePdfBlob;
    if (!groups.has(blob)) groups.set(blob, []);
    groups.get(blob).push(page);
  }

  for (const [blob, entries] of groups) {
    const pdfBytes = new Uint8Array(await blob.arrayBuffer());
    const pdfDoc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;

    for (const page of entries) {
      try {
        page.thumbnailDataUrl = await renderPageThumbnail(pdfDoc, page.originalPageIndex + 1);
      } catch {
        page.thumbnailDataUrl = null;
      }

      // Update just this card's image area — no full re-render needed
      const imgArea = document.querySelector(`[data-id="${page.id}"] .thumb-img`);
      if (imgArea) {
        if (page.thumbnailDataUrl) {
          const isLandscape = page.rotation === 90 || page.rotation === 270;
          imgArea.classList.toggle('thumb-img--landscape', isLandscape);
          imgArea.innerHTML = '';
          const img = document.createElement('img');
          img.src = page.thumbnailDataUrl;
          img.alt = page.sourceFileName;
          img.draggable = false;
          if (page.rotation) {
            img.style.transform = isLandscape
              ? `translate(-50%, -50%) rotate(${page.rotation}deg)`
              : `rotate(${page.rotation}deg)`;
          }
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
 * @param {object} pdfDoc  PDF.js PDFDocumentProxy
 * @param {number} pageNumber  1-based
 * @param {number} [width=160]  target width in pixels
 * @returns {Promise<string>}  PNG data URL
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
  const hasContent = documents.length > 0;
  uploadZone.classList.toggle('compact', hasContent);
  mainContent.classList.toggle('d-none', !hasContent);

  documentsContainer.innerHTML = '';
  for (const doc of documents) {
    documentsContainer.appendChild(createDocPane(doc));
  }

  // Restore selection highlight after DOM rebuild
  updateSelectionUI();
  updateUndoRedoButtons();
}

/** Build the full DOM element for one document pane. */
function createDocPane(doc) {
  const pane = document.createElement('div');
  pane.className = 'doc-pane';
  if (doc.id === activeDocId) pane.classList.add('doc-pane--active');
  pane.dataset.docId = doc.id;
  pane.addEventListener('click', () => setActiveDoc(doc.id));

  // ── Header ──────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'doc-pane-header';

  // Editable document name
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'doc-name-input';
  nameInput.value = doc.name;
  nameInput.addEventListener('click', e => e.stopPropagation());
  nameInput.addEventListener('change', () => {
    doc.name = nameInput.value.trim() || doc.name;
    nameInput.value = doc.name;
  });

  // Download button
  const btnDownload = document.createElement('button');
  btnDownload.className = 'btn btn-primary btn-sm';
  btnDownload.innerHTML = `${DL_ICON}Download PDF`;
  btnDownload.title = 'Download this document as a PDF';
  btnDownload.addEventListener('click', e => {
    e.stopPropagation();
    handleDocDownload(doc.id, btnDownload);
  });

  // Preview button
  const btnPreview = document.createElement('button');
  btnPreview.className = 'btn btn-outline-secondary btn-sm';
  btnPreview.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" class="me-1" viewBox="0 0 16 16"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.133 13.133 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5c-2.12 0-3.879-1.168-5.168-2.457A13.134 13.134 0 0 1 1.172 8z"/><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/></svg>Preview`;
  btnPreview.title = 'Preview this document as a PDF';
  btnPreview.addEventListener('click', e => {
    e.stopPropagation();
    previewDoc(doc.id);
  });

  // Burst button
  const btnBurst = document.createElement('button');
  btnBurst.className = 'btn btn-outline-secondary btn-sm';
  btnBurst.textContent = 'Burst';
  btnBurst.title = 'Save each page as its own PDF file';
  btnBurst.addEventListener('click', e => {
    e.stopPropagation();
    handleDocBurst(doc.id, btnBurst);
  });

  // ZIP button
  const btnZip = document.createElement('button');
  btnZip.className = 'btn btn-outline-secondary btn-sm';
  btnZip.textContent = 'ZIP';
  btnZip.title = 'Download all pages as individual PDFs in a ZIP archive';
  btnZip.addEventListener('click', e => {
    e.stopPropagation();
    handleDocZip(doc.id, btnZip);
  });

  // Split range toggle
  const btnSplitToggle = document.createElement('button');
  btnSplitToggle.className = 'btn btn-outline-secondary btn-sm';
  btnSplitToggle.textContent = 'Split range…';
  btnSplitToggle.title = 'Extract a range of pages as a new PDF';

  // Split range control group (hidden by default)
  const splitGroup = document.createElement('div');
  splitGroup.className = 'd-none split-group';

  const splitFromInput = document.createElement('input');
  splitFromInput.type = 'number';
  splitFromInput.className = 'form-control form-control-sm split-input';
  splitFromInput.min = 1;
  splitFromInput.placeholder = 'from';
  splitFromInput.addEventListener('click', e => e.stopPropagation());

  const splitToInput = document.createElement('input');
  splitToInput.type = 'number';
  splitToInput.className = 'form-control form-control-sm split-input';
  splitToInput.min = 1;
  splitToInput.placeholder = 'to';
  splitToInput.addEventListener('click', e => e.stopPropagation());

  const btnSplitExtract = document.createElement('button');
  btnSplitExtract.className = 'btn btn-outline-secondary btn-sm';
  btnSplitExtract.textContent = 'Extract';
  btnSplitExtract.addEventListener('click', e => {
    e.stopPropagation();
    handleDocSplitRange(doc.id, splitFromInput, splitToInput, btnSplitExtract);
  });

  splitGroup.appendChild(document.createTextNode('pages '));
  splitGroup.appendChild(splitFromInput);
  splitGroup.appendChild(document.createTextNode(' to '));
  splitGroup.appendChild(splitToInput);
  splitGroup.appendChild(btnSplitExtract);

  btnSplitToggle.addEventListener('click', e => {
    e.stopPropagation();
    const hidden = splitGroup.classList.toggle('d-none');
    btnSplitToggle.textContent = hidden ? 'Split range…' : 'Hide split';
    if (!hidden) {
      splitFromInput.max = doc.pages.length;
      splitToInput.max = doc.pages.length;
    }
  });

  // Remove document button
  const btnRemoveDoc = document.createElement('button');
  btnRemoveDoc.className = 'btn btn-outline-danger btn-sm ms-auto';
  btnRemoveDoc.textContent = '×';
  btnRemoveDoc.title = 'Remove this document';
  btnRemoveDoc.addEventListener('click', e => { e.stopPropagation(); removeDoc(doc.id); });

  header.appendChild(nameInput);
  header.appendChild(btnDownload);
  header.appendChild(btnPreview);
  header.appendChild(btnBurst);
  header.appendChild(btnZip);
  header.appendChild(btnSplitToggle);
  header.appendChild(splitGroup);
  header.appendChild(btnRemoveDoc);
  pane.appendChild(header);

  // ── Body / Grid ─────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'doc-pane-body';

  const grid = document.createElement('div');
  grid.className = 'thumbnail-grid';
  grid.dataset.docId = doc.id;

  if (doc.pages.length === 0) {
    grid.innerHTML = '<div class="doc-pane-empty">Drop PDF files here or use "+ Add PDFs" to add pages</div>';
  } else {
    doc.pages.forEach((page, index) => grid.appendChild(createCard(page, index, doc.id)));
  }

  // ── File drag onto grid ─────────────────────────────────────────────────
  grid.addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      grid.classList.add('drag-over-files');
    } else if (dragState.docId !== null) {
      // Allow page drops on the empty-area of the grid
      e.preventDefault();
    }
  });
  grid.addEventListener('dragleave', e => {
    if (!grid.contains(e.relatedTarget)) grid.classList.remove('drag-over-files');
  });
  grid.addEventListener('drop', e => {
    grid.classList.remove('drag-over-files');
    if (e.dataTransfer.files.length > 0) {
      // File drop — load into this document
      e.preventDefault();
      e.stopPropagation();
      handleFiles(e.dataTransfer.files, doc.id);
    } else if (dragState.docId !== null && !e.target.closest('.thumb-card')) {
      // Page dropped on empty grid area — append to end of this doc
      e.preventDefault();
      if (dragState.docId === doc.id) return; // same doc no-op
      movePageBetweenDocs(dragState.docId, dragState.pageIndex, doc.id, doc.pages.length);
      saveHistory();
      renderAll();
      renderThumbnailsProgressively();
    }
  });

  body.appendChild(grid);
  pane.appendChild(body);
  return pane;
}

/** Build a thumbnail card DOM element for one page. */
function createCard(page, index, docId) {
  const card = document.createElement('div');
  card.className = 'thumb-card';
  if (selectedPageIds.has(page.id)) card.classList.add('thumb-card--selected');
  card.setAttribute('draggable', 'true');
  card.dataset.index = index;
  card.dataset.id = page.id;

  // Image area
  const isLandscape = page.rotation === 90 || page.rotation === 270;
  const imgArea = document.createElement('div');
  imgArea.className = isLandscape ? 'thumb-img thumb-img--landscape' : 'thumb-img';
  if (page.thumbnailDataUrl) {
    const img = document.createElement('img');
    img.src = page.thumbnailDataUrl;
    img.alt = `Page ${index + 1}`;
    img.draggable = false; // prevent browser from dragging the img instead of the card
    if (page.rotation) {
      img.style.transform = isLandscape
        ? `translate(-50%, -50%) rotate(${page.rotation}deg)`
        : `rotate(${page.rotation}deg)`;
    }
    imgArea.appendChild(img);
  } else {
    imgArea.innerHTML = `<div class="thumb-placeholder">
      <div class="spinner-border spinner-border-sm text-secondary" role="status"></div>
    </div>`;
  }

  // Footer
  const footer = document.createElement('div');
  footer.className = 'thumb-footer';
  footer.innerHTML = `
    <span class="thumb-num">${index + 1}</span>
    <span class="thumb-name" title="${escHtml(page.sourceFileName)}">${escHtml(page.sourceFileName)}</span>
    <button class="btn-rotate" title="Rotate 90° clockwise">↻</button>
    <button class="btn-remove" title="Remove this page">&times;</button>
  `;

  card.appendChild(imgArea);
  card.appendChild(footer);

  // ── Click to select ──────────────────────────────────────────────────────
  card.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    if (e.ctrlKey || e.metaKey) {
      // Toggle individual page
      if (selectedPageIds.has(page.id)) selectedPageIds.delete(page.id);
      else selectedPageIds.add(page.id);
      lastSelectedId = page.id;
    } else if (e.shiftKey && lastSelectedId) {
      // Range select within the same document
      const doc = getDoc(docId);
      const ids = doc.pages.map(p => p.id);
      const a = ids.indexOf(lastSelectedId);
      const b = ids.indexOf(page.id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
        ids.slice(lo, hi + 1).forEach(id => selectedPageIds.add(id));
      } else {
        selectedPageIds.clear();
        selectedPageIds.add(page.id);
        lastSelectedId = page.id;
      }
    } else {
      // Plain click — single select
      selectedPageIds.clear();
      selectedPageIds.add(page.id);
      lastSelectedId = page.id;
    }
    updateSelectionUI();
  });

  // ── Context menu ─────────────────────────────────────────────────────────
  card.addEventListener('contextmenu', e => {
    e.stopPropagation();
    showContextMenu(e, docId, index);
  });

  // ── Drag-and-drop ────────────────────────────────────────────────────────
  card.addEventListener('dragstart', e => {
    dragState = { docId, pageIndex: index };
    card.classList.add('dragging');
    e.dataTransfer.setData('application/x-pdfworker', 'page');
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.thumb-card').forEach(c => c.classList.remove('drag-over-card'));
    dragState = { docId: null, pageIndex: -1 };
  });
  card.addEventListener('dragover', e => {
    if (dragState.docId === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!(dragState.docId === docId && dragState.pageIndex === index)) {
      card.classList.add('drag-over-card');
    }
  });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over-card'));
  card.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation(); // prevent grid drop handler from also firing
    card.classList.remove('drag-over-card');
    if (dragState.docId === null) return;
    if (dragState.docId === docId) {
      if (dragState.pageIndex !== index) {
        movePageWithinDoc(docId, dragState.pageIndex, index);
        saveHistory();
        renderAll();
        renderThumbnailsProgressively();
      }
    } else {
      movePageBetweenDocs(dragState.docId, dragState.pageIndex, docId, index);
      saveHistory();
      renderAll();
      renderThumbnailsProgressively();
    }
  });

  // ── Rotate button ─────────────────────────────────────────────────────────
  footer.querySelector('.btn-rotate').addEventListener('click', e => {
    e.stopPropagation();
    const doc = getDoc(docId);
    const idx = doc.pages.findIndex(p => p.id === page.id);
    if (idx === -1) return;
    // Create new PageItem (preserve immutability contract for history snapshots)
    const newPage = { ...page, rotation: (page.rotation + 90) % 360 };
    doc.pages[idx] = newPage;
    saveHistory();
    renderAll();
    renderThumbnailsProgressively();
  });

  // ── Remove button ─────────────────────────────────────────────────────────
  footer.querySelector('.btn-remove').addEventListener('click', e => {
    e.stopPropagation();
    const doc = getDoc(docId);
    doc.pages = doc.pages.filter(p => p.id !== page.id);
    selectedPageIds.delete(page.id);
    saveHistory();
    renderAll();
  });

  return card;
}

// ---------------------------------------------------------------------------
// Page mutations
// ---------------------------------------------------------------------------

function movePageWithinDoc(docId, fromIndex, toIndex) {
  const doc = getDoc(docId);
  const [item] = doc.pages.splice(fromIndex, 1);
  doc.pages.splice(toIndex, 0, item);
}

function movePageBetweenDocs(srcDocId, srcIndex, tgtDocId, tgtIndex) {
  const src = getDoc(srcDocId);
  const tgt = getDoc(tgtDocId);
  const [item] = src.pages.splice(srcIndex, 1);
  tgt.pages.splice(tgtIndex, 0, item);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function updateSelectionUI() {
  document.querySelectorAll('.thumb-card').forEach(c => {
    c.classList.toggle('thumb-card--selected', selectedPageIds.has(c.dataset.id));
  });
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

function handleKeyDown(e) {
  // Don't fire shortcuts when user is typing in an input
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault(); undo(); return;
  }
  if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault(); redo(); return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    selectedPageIds.clear();
    lastSelectedId = null;
    updateSelectionUI();
    hideContextMenu();
    return;
  }

  if (selectedPageIds.size === 0) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    for (const doc of documents) {
      doc.pages = doc.pages.filter(p => !selectedPageIds.has(p.id));
    }
    selectedPageIds.clear();
    lastSelectedId = null;
    saveHistory();
    renderAll();
    return;
  }

  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    // Arrow-move only applies to a single-page selection
    if (selectedPageIds.size !== 1) return;
    const [selectedPageId] = selectedPageIds;
    e.preventDefault();
    const loc = findPageLocation(selectedPageId);
    if (!loc) return;
    const doc = getDoc(loc.docId);
    const newIndex = loc.index + (e.key === 'ArrowLeft' ? -1 : 1);
    if (newIndex < 0 || newIndex >= doc.pages.length) return;
    movePageWithinDoc(loc.docId, loc.index, newIndex);
    saveHistory();
    renderAll();
    updateSelectionUI(); // restore highlight after DOM rebuild
  }
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

function showContextMenu(e, docId, pageIndex) {
  e.preventDefault();
  contextTarget = { docId, pageIndex };

  // Update labels to reflect multi-select when the right-clicked page is in the selection
  const doc = getDoc(docId);
  const contextPageId = doc?.pages[pageIndex]?.id;
  const multiAffected = contextPageId && selectedPageIds.has(contextPageId) && selectedPageIds.size > 1;
  contextMenu.querySelector('[data-action="rotate"]').textContent =
    multiAffected ? `Rotate ${selectedPageIds.size} pages 90° clockwise` : 'Rotate 90° clockwise';
  contextMenu.querySelector('[data-action="remove"]').textContent =
    multiAffected ? `Remove ${selectedPageIds.size} selected pages` : 'Remove page';

  // Populate "Move to…" section (only visible when multiple docs exist)
  const otherDocs = documents.filter(d => d.id !== docId);
  if (otherDocs.length > 0) {
    contextMoveSection.classList.remove('d-none');
    contextMoveTargets.innerHTML = '';
    for (const d of otherDocs) {
      const item = document.createElement('div');
      item.className = 'context-menu-item context-menu-item--indent';
      item.textContent = d.name;
      item.addEventListener('click', ev => {
        ev.stopPropagation();
        movePageBetweenDocs(docId, pageIndex, d.id, d.pages.length);
        saveHistory();
        hideContextMenu();
        renderAll();
        renderThumbnailsProgressively();
      });
      contextMoveTargets.appendChild(item);
    }
  } else {
    contextMoveSection.classList.add('d-none');
  }

  // Show menu, measure, then reposition clamped to viewport
  contextMenu.classList.remove('d-none');
  contextMenu.style.left = '0px';
  contextMenu.style.top = '0px';
  const rect = contextMenu.getBoundingClientRect();
  const x = Math.min(e.clientX, window.innerWidth  - rect.width  - 8);
  const y = Math.min(e.clientY, window.innerHeight - rect.height - 8);
  contextMenu.style.left = `${Math.max(8, x)}px`;
  contextMenu.style.top  = `${Math.max(8, y)}px`;
}

function hideContextMenu() {
  contextMenu.classList.add('d-none');
  contextTarget = null;
}

function handleContextAction(action) {
  const { docId, pageIndex } = contextTarget;
  const doc = getDoc(docId);
  if (!doc || pageIndex < 0 || pageIndex >= doc.pages.length) {
    hideContextMenu();
    return;
  }

  const contextPageId = doc.pages[pageIndex].id;
  const multiAffected = selectedPageIds.has(contextPageId) && selectedPageIds.size > 1;

  if (action === 'rotate') {
    if (multiAffected) {
      // Rotate all selected pages across all documents
      for (const d of documents) {
        d.pages = d.pages.map(p =>
          selectedPageIds.has(p.id) ? { ...p, rotation: (p.rotation + 90) % 360 } : p
        );
      }
    } else {
      const p = doc.pages[pageIndex];
      doc.pages[pageIndex] = { ...p, rotation: (p.rotation + 90) % 360 };
    }
  } else if (action === 'duplicate') {
    const clone = { ...doc.pages[pageIndex], id: crypto.randomUUID() };
    doc.pages.splice(pageIndex + 1, 0, clone);
  } else if (action === 'remove') {
    if (multiAffected) {
      // Remove all selected pages across all documents
      for (const d of documents) {
        d.pages = d.pages.filter(p => !selectedPageIds.has(p.id));
      }
      selectedPageIds.clear();
      lastSelectedId = null;
    } else {
      selectedPageIds.delete(contextPageId);
      doc.pages.splice(pageIndex, 1);
    }
  } else if (action === 'remove-before') {
    doc.pages = doc.pages.slice(pageIndex);
  } else if (action === 'remove-after') {
    doc.pages = doc.pages.slice(0, pageIndex + 1);
  }

  saveHistory();
  hideContextMenu();
  renderAll();
  renderThumbnailsProgressively();
}

// ---------------------------------------------------------------------------
// Per-document toolbar handlers
// ---------------------------------------------------------------------------

async function handleDocDownload(docId, btn) {
  const doc = getDoc(docId);
  if (!doc?.pages.length) { bsToast.show('No pages to download.', 'warning'); return; }
  let meta;
  try {
    meta = await promptForMetadata({ title: doc.name });
  } catch {
    return; // user cancelled
  }
  setButtonBusy(btn, 'Building…');
  try {
    const bytes = await buildPdf(doc.pages, meta);
    downloadPdf(bytes, `${safeFilename(doc.name)}.pdf`);
    bsToast.show(`Downloaded ${doc.pages.length}-page PDF.`, 'success');
  } catch (err) {
    bsToast.show(`Error: ${err.message}`, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${DL_ICON}Download PDF`;
  }
}

async function handleDocBurst(docId, btn) {
  const doc = getDoc(docId);
  if (!doc?.pages.length) { bsToast.show('No pages to burst.', 'warning'); return; }
  if (doc.pages.length > 20 && !confirm(
    `This will download ${doc.pages.length} individual PDF files. Your browser may ask you to allow multiple downloads. Continue?`
  )) return;

  setButtonBusy(btn, 'Bursting…');
  try {
    const base = safeFilename(doc.name);
    for (let i = 0; i < doc.pages.length; i++) {
      const bytes = await buildPdf([doc.pages[i]]);
      downloadPdf(bytes, `${base}-page-${String(i + 1).padStart(3, '0')}.pdf`);
      if (i < doc.pages.length - 1) await delay(120);
    }
    bsToast.show(`Burst complete — ${doc.pages.length} files downloaded.`, 'success');
  } catch (err) {
    bsToast.show(`Error: ${err.message}`, 'danger');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Burst';
  }
}

async function handleDocZip(docId, btn) {
  if (typeof fflate === 'undefined') {
    bsToast.show('ZIP export unavailable (fflate library not loaded).', 'danger');
    return;
  }
  const doc = getDoc(docId);
  if (!doc?.pages.length) { bsToast.show('No pages to ZIP.', 'warning'); return; }

  let meta;
  try {
    meta = await promptForMetadata({ title: doc.name });
  } catch {
    return; // user cancelled
  }

  setButtonBusy(btn, 'Building…');
  bsToast.show(`Packaging ${doc.pages.length} pages…`, 'secondary');

  try {
    const base = safeFilename(doc.name);
    const files = {};
    for (let i = 0; i < doc.pages.length; i++) {
      const bytes = await buildPdf([doc.pages[i]], meta);
      files[`page-${String(i + 1).padStart(3, '0')}.pdf`] = bytes;
    }

    await new Promise((resolve, reject) => {
      // level: 0 = store only — PDFs are already compressed internally
      fflate.zip(files, { level: 0 }, (err, data) => {
        if (err) { reject(err); return; }
        downloadBlob(new Blob([data], { type: 'application/zip' }), `${base}-pages.zip`);
        resolve();
      });
    });

    bsToast.show(`Downloaded ${doc.pages.length}-page ZIP.`, 'success');
  } catch (err) {
    bsToast.show(`ZIP error: ${err.message}`, 'danger');
  } finally {
    btn.disabled = false;
    btn.textContent = 'ZIP';
  }
}

async function handleDocSplitRange(docId, fromInput, toInput, btn) {
  const doc = getDoc(docId);
  if (!doc) return;
  const from = parseInt(fromInput.value, 10);
  const to   = parseInt(toInput.value,   10);
  if (isNaN(from) || isNaN(to)) { bsToast.show('Enter a page range first.', 'warning'); return; }
  if (from < 1 || to > doc.pages.length || from > to) {
    bsToast.show(`Range must be between 1 and ${doc.pages.length}.`, 'warning');
    return;
  }
  let meta;
  try {
    meta = await promptForMetadata({ title: `${doc.name} (pages ${from}–${to})` });
  } catch {
    return; // user cancelled
  }
  setButtonBusy(btn, 'Extracting…');
  try {
    const bytes = await buildPdf(doc.pages.slice(from - 1, to), meta);
    downloadPdf(bytes, `${safeFilename(doc.name)}-pages-${from}-to-${to}.pdf`);
    bsToast.show(`Extracted pages ${from}–${to}.`, 'success');
  } catch (err) {
    bsToast.show(`Error: ${err.message}`, 'danger');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Extract';
  }
}

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------

/**
 * Show the password dialog for an encrypted PDF and return the entered password.
 * Rejects if the user clicks "Skip file" or closes the dialog.
 * @param {string} filename
 * @returns {Promise<string>}
 */
function promptForPassword(filename) {
  return new Promise((resolve, reject) => {
    const dialog = document.getElementById('passwordDialog');
    document.getElementById('passwordDialogFileName').textContent = filename;
    document.getElementById('passwordError').style.display = 'none';
    document.getElementById('passwordInput').value = '';

    const onSubmit = () => {
      resolve(document.getElementById('passwordInput').value);
      cleanup();
      dialog.close();
    };
    const onSkip = () => {
      reject(new Error('cancelled'));
      cleanup();
      dialog.close();
    };
    const onCancel = () => { // Escape key
      reject(new Error('cancelled'));
      cleanup();
    };
    const cleanup = () => {
      document.getElementById('passwordSubmitBtn').removeEventListener('click', onSubmit);
      document.getElementById('passwordSkipBtn').removeEventListener('click', onSkip);
      dialog.removeEventListener('cancel', onCancel);
    };

    document.getElementById('passwordSubmitBtn').addEventListener('click', onSubmit, { once: true });
    document.getElementById('passwordSkipBtn').addEventListener('click', onSkip, { once: true });
    document.getElementById('passwordCancelBtn').addEventListener('click', onSkip, { once: true });
    dialog.addEventListener('cancel', onCancel, { once: true });
    dialog.showModal();
    document.getElementById('passwordInput').focus();
  });
}

/**
 * Show the metadata dialog and return the user-entered metadata.
 * Rejects if the user cancels.
 * @param {{ title?: string, author?: string, subject?: string }} defaults
 * @returns {Promise<{title:string, author:string, subject:string}>}
 */
function promptForMetadata(defaults = {}) {
  return new Promise((resolve, reject) => {
    const dialog = document.getElementById('metadataDialog');
    document.getElementById('metaTitle').value   = defaults.title   || '';
    document.getElementById('metaAuthor').value  = defaults.author  || '';
    document.getElementById('metaSubject').value = defaults.subject || '';

    const onConfirm = () => {
      resolve({
        title:   document.getElementById('metaTitle').value.trim(),
        author:  document.getElementById('metaAuthor').value.trim(),
        subject: document.getElementById('metaSubject').value.trim(),
      });
      cleanup();
      dialog.close();
    };
    const onCancel = () => {
      reject(new Error('cancelled'));
      cleanup();
      if (dialog.open) dialog.close();
    };
    const cleanup = () => {
      document.getElementById('metadataConfirmBtn').removeEventListener('click', onConfirm);
      document.getElementById('metadataCancelBtn').removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onCancel);
    };

    document.getElementById('metadataConfirmBtn').addEventListener('click', onConfirm, { once: true });
    document.getElementById('metadataCancelBtn').addEventListener('click', onCancel, { once: true });
    dialog.addEventListener('cancel', onCancel, { once: true });
    dialog.showModal();
    document.getElementById('metaTitle').focus();
  });
}

// ---------------------------------------------------------------------------
// IndexedDB persistence
// ---------------------------------------------------------------------------

/** Open (or create) the PdfWorkerDB database. */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('PdfWorkerDB', 1);
    req.onupgradeneeded = e => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains('documents')) {
        idb.createObjectStore('documents', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

/** Save the current documents state to IndexedDB. No-ops if db is unavailable. */
function persistState() {
  if (!db) return Promise.resolve();
  // Snapshot data BEFORE opening the transaction (avoids any async work inside it)
  const snapshots = documents.map(doc => ({
    id:    doc.id,
    name:  doc.name,
    pages: doc.pages.map(p => ({
      id:                p.id,
      sourceFileName:    p.sourceFileName,
      sourcePdfBlob:     p.sourcePdfBlob,   // Blobs are directly storable in IndexedDB
      originalPageIndex: p.originalPageIndex,
      thumbnailDataUrl:  p.thumbnailDataUrl,
      rotation:          p.rotation,
    })),
  }));

  // All IDB operations run synchronously — no await inside, so the transaction
  // cannot auto-commit between clear() and the put() calls.
  return new Promise((resolve, reject) => {
    const tx = db.transaction('documents', 'readwrite');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    const store = tx.objectStore('documents');
    store.clear();
    for (const snap of snapshots) {
      store.put(snap);
    }
  });
}

/** Restore documents from IndexedDB on startup. Renders the restored state. */
async function restoreState() {
  if (!db) return;
  const tx = db.transaction('documents', 'readonly');
  const store = tx.objectStore('documents');
  const rows = await new Promise((res, rej) => {
    const r = store.getAll(); r.onsuccess = () => res(r.result); r.onerror = rej;
  });
  if (!rows.length) return;

  documents = rows.map(row => ({
    id:    row.id,
    name:  row.name,
    pages: row.pages.map(p => ({ ...p })),
  }));
  activeDocId = documents[0]?.id ?? null;

  // Seed the history baseline so undo/redo starts from the restored state
  history = [[], documents.map(doc => ({ ...doc, pages: [...doc.pages] }))];
  historyIndex = 1;

  renderAll();
  renderThumbnailsProgressively();
  updateUndoRedoButtons();
}

// ---------------------------------------------------------------------------
// Global toolbar handlers
// ---------------------------------------------------------------------------

function handleClearAll() {
  if (!documents.length) return;
  if (!confirm('Clear all documents and pages? This cannot be undone.')) return;
  documents = [];
  activeDocId = null;
  selectedPageIds.clear();
  lastSelectedId = null;
  history = [[]];
  historyIndex = 0;
  persistState().catch(console.error);
  renderAll();
}
