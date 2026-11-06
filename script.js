/* MyDigitalLibary Phase 6: compatible with Phase 4/5 saved books and backups */
const STORAGE_KEY = "mydigitallibary-books-v1";
const BACKUP_FORMAT = "MyDigitalLibary-backup";
const PREFS_KEY = "mydigitallibary-preferences-v1";
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const validThemes = ["minimal", "sage", "blush", "midnight"];
const validFonts = ["modern", "classic", "rounded", "simple", "literary"];
let searchQuery = "";
let statusFilter = "all";
let sortMode = "series-volume";
let books = [];
let editingId = null;
let selectedId = null;

const $ = (id) => document.getElementById(id);
const container = $("book-container");
const bookDialog = $("book-dialog");
const detailsDialog = $("details-dialog");
const form = $("book-form");
const money = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const cleanText = (value, max = 120) => typeof value === "string" ? value.trim().slice(0, max) : "";
const statusOptions = ["Unread", "Reading", "Read"];

function showMessage(message) { $("page-message").textContent = message; }
function readLibrary() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Saved data is not a list");
    return parsed;
  } catch (error) {
    console.error(error);
    showMessage("Your saved library could not be loaded. No data was overwritten; check browser storage before adding or importing books.");
    throw error;
  }
}

function saveLibrary(nextBooks) {
  // IMPORTANT: only change the in-memory books after localStorage succeeds.
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextBooks));
  books = nextBooks;
  render();
}

function makeText(tag, className, content) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = String(content ?? "");
  return el;
}
function isEmbeddedImage(value) {
  return typeof value === "string" && /^data:image\/(jpeg|png|webp);base64,[a-zA-Z0-9+/=]+$/.test(value);
}
function isSafeImage(value) {
  if (isEmbeddedImage(value)) return true;
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    // Keep existing Google Books and Open Library cover URLs working.
    const knownBookHosts = ["books.google.com", "books.googleusercontent.com", "books.google.co.uk", "covers.openlibrary.org"];
    if (knownBookHosts.includes(url.hostname)) return true;
    return /\.(jpe?g|png|webp)$/i.test(url.pathname);
  } catch { return false; }
}
function amazonProductId(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/(^|\.)amazon\.(com|co\.uk|ca|de|fr|co\.jp|es|it|com\.au|in)$/.test(url.hostname)) return "";
    const match = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Za-z0-9]{10})(?:\/|$)/i);
    return match?.[1].toUpperCase() || "";
  } catch { return ""; }
}
function validAmazonLink(value) { return Boolean(amazonProductId(value)); }

function validISBN(s) {
  const v = String(s).replace(/[^0-9Xx]/g, "").toUpperCase();
  if (v.length === 10) return v.split("").reduce((acc,c,i) => acc + (c === "X" ? 10 : Number(c)) * (10-i), 0) % 11 === 0;
  if (v.length === 13) return v.split("").reduce((acc,c,i) => acc + Number(c) * (i%2 ? 3 : 1), 0) % 10 === 0;
  return false;
}
function appendCover(parent, book, className = "book-cover") {
  const cover = document.createElement("div");
  cover.className = className;
  cover.style.backgroundColor = /^#[0-9a-fA-F]{6}$/.test(book.color || "") ? book.color : "#53677a";
  if (isSafeImage(book.image)) {
    cover.classList.add("has-image");
    // A real photo is shown unobstructed in Grid and Details views.
    const photo = document.createElement("img");
    photo.className = "front-photo";
    photo.src = book.image;
    photo.alt = `Front cover of ${book.title}`;
    photo.onerror = () => { photo.remove(); cover.classList.remove("has-image"); };
    cover.append(photo);
  }
  const labels = document.createElement("div");
  labels.className = "cover-placeholder-labels";
  labels.append(
    makeText("span", "cover-label", "♡"),
    makeText("span", "cover-title", book.title),
    makeText("span", "cover-volume", book.volume !== "" && book.volume != null ? `VOL. ${book.volume}` : "MY BOOK")
  );
  cover.append(labels);
  parent.append(cover);
  return cover;
}
// Sorting changes the DISPLAY only; it never rewrites saved books.
// Works when the Series field is filled in AND when the volume is in the title,
// e.g. "One Piece, Vol. 10", "One Piece Volume 2", "Naruto #3".
function titleWithoutVolume(value) {
  return String(value || "")
    .trim()
    .replace(/(?:\s*[,:(\-–—]?\s*)(?:(?:vol(?:ume)?|book|tome)\.?\s*#?\s*|#\s*)(\d+(?:\.\d+)?)(?:\s*[)\]])?\s*$/i, "")
    .replace(/[\s,:;\-–—(]+$/, "")
    .trim();
}
function seriesName(book) {
  return String(book.series || "").trim() || titleWithoutVolume(book.title) || String(book.title || "").trim();
}
function volumeNumber(book) {
  const supplied = book.volume;
  if (supplied !== "" && supplied !== null && supplied !== undefined && Number.isFinite(Number(supplied))) {
    return Number(supplied);
  }
  const title = String(book.title || "");
  const match = title.match(/(?:vol(?:ume)?|book|tome)\.?\s*#?\s*(\d+(?:\.\d+)?)\s*[)\]]?\s*$|#\s*(\d+(?:\.\d+)?)\s*$/i);
  return match ? Number(match[1] || match[2]) : null;
}
function compareVolumes(a, b, direction = 1) {
  const av = volumeNumber(a), bv = volumeNumber(b);
  if (av === null && bv === null) return 0;
  if (av === null) return 1;  // books without volume numbers appear last in a series
  if (bv === null) return -1;
  return (av - bv) * direction;
}
function getVisibleBooks() {
  const query = searchQuery.trim().toLocaleLowerCase();
  const indexed = books.map((book, index) => ({ book, index }));
  const shown = indexed.filter(({book}) => {
    const matchesStatus = statusFilter === "all" || (book.status || "Unread") === statusFilter;
    const terms = [book.title, book.author, book.series].map(x => String(x || "").toLocaleLowerCase());
    return matchesStatus && (!query || terms.some(x => x.includes(query)));
  });
  shown.sort((a, b) => {
    const x = a.book, y = b.book;
    let result = 0;
    switch (sortMode) {
      case "added-asc": return a.index - b.index;
      case "added-desc": return b.index - a.index;
      case "series-volume":
        result = collator.compare(seriesName(x), seriesName(y))
          || compareVolumes(x, y)
          || collator.compare(x.title || "", y.title || "");
        break;
      case "volume-asc": result = compareVolumes(x, y); break;
      case "volume-desc": result = compareVolumes(x, y, -1); break;
      case "title-asc":
        // Sort by series/title without the volume suffix first, then by
        // numeric volume. This keeps e.g. Naruto Vol. 2 ahead of Vol. 10.
        result = collator.compare(seriesName(x), seriesName(y))
          || compareVolumes(x, y)
          || collator.compare(x.title || "", y.title || "");
        break;
      case "author-asc": result = collator.compare(x.author || "", y.author || "")
        || collator.compare(seriesName(x), seriesName(y))
        || compareVolumes(x, y); break;
      case "price-desc": {
        const xp = x.pricePaid === null || x.pricePaid === "" || x.pricePaid === undefined ? null : Number(x.pricePaid);
        const yp = y.pricePaid === null || y.pricePaid === "" || y.pricePaid === undefined ? null : Number(y.pricePaid);
        if (xp === null && yp !== null) result = 1;
        else if (yp === null && xp !== null) result = -1;
        else result = (yp || 0) - (xp || 0);
        break;
      }
    }
    return result || a.index - b.index;
  });
  return shown.map(({book}) => book);
}
function savePreferences() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({theme: $("library-theme").value, font: $("library-font").value}));
  } catch (error) {
    showMessage("Your books are safe, but your display preference could not be saved.");
  }
}
function applyTheme(value) {
  const theme = validThemes.includes(value) ? value : "minimal";
  document.documentElement.dataset.theme = theme;
  $("library-theme").value = theme;
  savePreferences();
}
$("search-books").addEventListener("input", (event) => {
  searchQuery = event.target.value;
  render();
});
$("filter-status").addEventListener("change", (event) => {
  statusFilter = event.target.value;
  render();
});
$("sort-books").addEventListener("change", (event) => {
  sortMode = event.target.value;
  render();
});
function applyFont(value) {
  const font = validFonts.includes(value) ? value : "modern";
  document.documentElement.dataset.font = font;
  $("library-font").value = font;
  savePreferences();
}
$("library-theme").addEventListener("change", (event) => applyTheme(event.target.value));
$("library-font").addEventListener("change", (event) => applyFont(event.target.value));
$("clear-filters").addEventListener("click", () => {
  searchQuery = "";
  statusFilter = "all";
  $("search-books").value = "";
  $("filter-status").value = "all";
  render();
  $("search-books").focus();
});
function restorePreferences() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    applyTheme(prefs.theme);
    applyFont(prefs.font);
  } catch (error) {
    document.documentElement.dataset.theme = "minimal";
    document.documentElement.dataset.font = "modern";
  }
}

function render() {
  container.replaceChildren();
  const visibleBooks = getVisibleBooks();
  if (visibleBooks.length === 0) {
    const message = books.length === 0
      ? "Your collection is empty. Click + Add Book to begin!"
      : "No matching books. Try a different search or filter.";
    container.append(makeText("p", "empty-message", message));
  }
  for (const book of visibleBooks) {
    const article = document.createElement("article");
    article.className = "book";
    article.tabIndex = 0;
    article.setAttribute("role", "button");
    article.setAttribute("aria-label", `View details for ${book.title}`);
    appendCover(article, book);
    const info = document.createElement("div");
    info.className = "book-info";
    info.append(makeText("h3", "", book.title), makeText("p", "book-author", book.author || "Unknown author"));
    if (book.series) info.append(makeText("p", "book-series", book.series));
    info.append(makeText("span", "reading-status", book.status || "Unread"));
    article.append(info);
    article.addEventListener("click", () => openDetails(book.id));
    article.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetails(book.id); }
    });
    container.append(article);
  }
  $("total-books").textContent = books.length;
  $("books-read").textContent = books.filter(b => b.status === "Read").length;
  $("currently-reading").textContent = books.filter(b => b.status === "Reading").length;
  // Use only valid, recorded prices; missing prices are not treated as zero
  // when calculating the per-book comparison.
  const recordedAmount = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const totalSpent = books.reduce((sum, b) => sum + (recordedAmount(b.pricePaid) ? Number(b.pricePaid) : 0), 0);
  const totalValue = books.reduce((sum, b) => sum + (recordedAmount(b.estimatedValue) ? Number(b.estimatedValue) : 0), 0);
  const completeBooks = books.filter(b => recordedAmount(b.pricePaid) && recordedAmount(b.estimatedValue));
  // Positive = current collection value exceeds cost. Negative = overspent.
  // Compare only books that have both prices, avoiding misleading missing-data zeros.
  const differenceCents = completeBooks.reduce((sum, b) =>
    sum + Math.round(Number(b.estimatedValue) * 100) - Math.round(Number(b.pricePaid) * 100), 0);
  const difference = differenceCents / 100;
  $("total-spent").textContent = money(totalSpent);
  $("total-value").textContent = money(totalValue);
  $("total-saved").textContent = (difference > 0 ? "+" : "") + money(difference);
  $("total-saved").classList.toggle("positive-balance", difference > 0);
  $("total-saved").classList.toggle("negative-balance", difference < 0);
  const coverage = `${completeBooks.length} of ${books.length} books have both prices entered.`;
  $("savings-note").textContent = completeBooks.length === 0
    ? "Add Price Paid and Current Value Price to calculate your savings. " + coverage
    : (difference > 0 ? "You're ahead: your recorded books are worth more than you paid. "
      : difference < 0 ? "You overspent relative to their current value. "
      : "Your current value matches what you paid. ") + coverage;
  $("collection-description").textContent = `${books.length} ${books.length === 1 ? "book" : "books"} in your collection`;
  $("results-count").textContent = `Showing ${visibleBooks.length} of ${books.length} ${books.length === 1 ? "book" : "books"}`;
  container.className = "book-container grid-mode";
}

function openForm(book = null) {
  form.reset();
  $("form-error").textContent = "";
  editingId = book ? book.id : null;
  $("form-title").textContent = book ? "Edit Book" : "Add a New Book";
  $("save-book").textContent = book ? "Save Changes" : "Save Book";
  $("remove-cover-row").hidden = !(book && isSafeImage(book.image));
  $("book-cover-url").value = book?.image && !isEmbeddedImage(book.image) ? book.image : "";
  $("cover-preview").hidden = true;
  $("cover-preview-message").textContent = "";
  $("cover-help").textContent = book ? "Leave blank to keep the current cover, or choose a replacement (under 8 MB)." : "Optional JPG, PNG, or WebP, under 8 MB. The image is reduced before saving.";
  if (book) {
    $("book-title").value = book.title || "";
    $("book-author").value = book.author || "";
    $("book-series").value = book.series || "";
    $("book-volume").value = book.volume ?? "";
    $("book-price").value = book.pricePaid ?? "";
    $("book-value").value = book.estimatedValue ?? "";
    $("book-status").value = statusOptions.includes(book.status) ? book.status : "Unread";
  }
  bookDialog.showModal();
}
$("add-book").addEventListener("click", () => openForm());
$("close-dialog").addEventListener("click", () => bookDialog.close());
$("cancel-book").addEventListener("click", () => bookDialog.close());

function addDetail(list, label, text) {
  list.append(makeText("dt", "", label), makeText("dd", "", text));
}
function displayPrice(amount) {
  return amount === null || amount === "" || amount === undefined || !Number.isFinite(Number(amount)) ? "Not recorded" : money(Number(amount));
}
function openDetails(id) {
  const book = books.find(b => b.id === id);
  if (!book) return;
  selectedId = id;
  $("details-title").textContent = book.title;
  const area = $("details-content");
  area.replaceChildren();
  const coverWrap = document.createElement("div");
  const preview = appendCover(coverWrap, book, "book-cover detail-preview");
  area.append(preview);
  const list = document.createElement("dl");
  list.className = "detail-list";
  addDetail(list, "Title", book.title);
  addDetail(list, "Author", book.author || "Not recorded");
  addDetail(list, "Series", book.series || "Not recorded");
  addDetail(list, "Volume", book.volume !== "" && book.volume != null ? String(book.volume) : "Not recorded");
  addDetail(list, "Reading Status", book.status || "Unread");
  addDetail(list, "Price Paid", displayPrice(book.pricePaid));
  if (book.pricePaid !== null && book.pricePaid !== undefined && book.pricePaid !== "" && book.estimatedValue !== null && book.estimatedValue !== undefined && book.estimatedValue !== "") {
    const differenceCents = Math.round(Number(book.estimatedValue) * 100) - Math.round(Number(book.pricePaid) * 100);
    const difference = differenceCents / 100;
    if (Number.isFinite(difference)) addDetail(list, "Savings / Overspending (Value − Paid)", (difference > 0 ? "+" : "") + money(difference));
  }
  addDetail(list, "Current Value Price", displayPrice(book.estimatedValue));
  if (book.amazonUrl && validAmazonLink(book.amazonUrl)) {
    const dt = makeText("dt", "", "Amazon listing");
    const dd = document.createElement("dd");
    const link = document.createElement("a");
    link.href = book.amazonUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open original product link";
    dd.append(link); list.append(dt, dd);
  }
  area.append(list);
  detailsDialog.showModal();
}
$("close-details").addEventListener("click", () => detailsDialog.close());
$("edit-book").addEventListener("click", () => {
  const book = books.find(b => b.id === selectedId);
  detailsDialog.close();
  if (book) openForm(book);
});
$("delete-book").addEventListener("click", () => {
  const book = books.find(b => b.id === selectedId);
  if (!book) return;
  if (!confirm(`Permanently delete "${book.title}" from your library? Export a backup first if you might need it later.`)) return;
  try {
    saveLibrary(books.filter(b => b.id !== selectedId));
    detailsDialog.close();
    selectedId = null;
    showMessage("Book deleted. Export a backup to preserve your current collection.");
  } catch (error) { alert("Could not delete the book because browser storage failed."); }
});

function processCover(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve("");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return reject(new Error("Choose a JPG, PNG, or WebP image."));
    if (file.size > 8 * 1024 * 1024) return reject(new Error("Cover must be smaller than 8 MB."));
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      try {
        const scale = Math.min(1, 450 / image.width, 650 / image.height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Image processing is unavailable.");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", .72));
      } catch (error) { reject(error); }
      finally { URL.revokeObjectURL(url); }
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not open that image.")); };
    image.src = url;
  });
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const submit = $("save-book");
  submit.disabled = true;
  $("form-error").textContent = "";
  try {
    const original = editingId ? books.find(b => b.id === editingId) : null;
    if (editingId && !original) throw new Error("This book no longer exists.");
    const file = $("book-cover").files[0];
    let image = original?.image || "";
    if ($("remove-cover").checked) image = "";
    const enteredUrl = $("book-cover-url").value.trim();
    if (enteredUrl && !isSafeImage(enteredUrl)) {
      throw new Error("Use a direct HTTPS image URL ending in .jpg, .jpeg, .png or .webp (or upload the image instead).");
    }
    if (enteredUrl) image = enteredUrl;
    if (file) image = await processCover(file); // Uploaded file takes priority over URL
    const updated = {
      id: original?.id || crypto.randomUUID(),
      title: cleanText($("book-title").value, 120),
      author: cleanText($("book-author").value, 100),
      series: cleanText($("book-series").value, 100),
      volume: $("book-volume").value,
      pricePaid: $("book-price").value === "" ? null : Number($("book-price").value),
      // Retain old original price in saved records only for backward compatibility.
      originalPrice: original?.originalPrice ?? null,
      estimatedValue: $("book-value").value === "" ? null : Number($("book-value").value),
      status: $("book-status").value,
      color: original?.color || "#53677a",
      image,
      // Legacy spine data remains intact in existing records for backup compatibility.
      spineImage: original?.spineImage || "",
      spineText: original?.spineText || "",
      spineColor: original?.spineColor || "#53677a",
    };
    if (!updated.title) throw new Error("Please enter a book title.");
    if (!statusOptions.includes(updated.status)) throw new Error("Invalid reading status.");
    const next = original ? books.map(b => b.id === original.id ? updated : b) : [...books, updated];
    saveLibrary(next);
    bookDialog.close();
    showMessage(original ? "Book updated successfully!" : "Book added successfully!");
  } catch (error) {
    $("form-error").textContent = error instanceof DOMException && error.name === "QuotaExceededError"
      ? "Your browser storage is full. Export a backup and try a smaller image."
      : `Could not save book: ${error.message || "Browser storage may be unavailable."}`;
  } finally {
    submit.disabled = false;
    submit.textContent = editingId ? "Save Changes" : "Save Book";
  }
});

// Download an entire JSON backup, including book cover image data.
$("export-books").addEventListener("click", () => {
  try {
    const backup = { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), books };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `MyDigitalLibary-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showMessage("Backup download started. Keep the JSON file somewhere safe.");
  } catch (error) { showMessage("Backup export failed. Please try again."); }
});
$("import-books").addEventListener("click", () => $("import-file").click());

// Validate backup records before touching your existing saved collection.
function validateBackup(data) {
  if (!data || data.format !== BACKUP_FORMAT || data.version !== 1 || !Array.isArray(data.books)) {
    throw new Error("This is not a supported MyDigitalLibary backup.");
  }
  if (data.books.length > 10000) throw new Error("Backup contains too many books.");
  const seen = new Set();
  return data.books.map((b, index) => {
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error(`Invalid book at position ${index + 1}.`);
    const title = cleanText(b.title, 120);
    if (!title || title !== b.title) throw new Error(`Invalid title at position ${index + 1}.`);
    const status = b.status;
    if (!statusOptions.includes(status)) throw new Error(`Invalid status at position ${index + 1}.`);
    const id = b.id;
    if (typeof id !== "string" || id.length < 1 || id.length > 100 || seen.has(id)) throw new Error("Invalid or repeated book ID in backup.");
    seen.add(id);
    const numberOrNull = (v) => {
      if (v === null || v === undefined || v === "") return null;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1e10) throw new Error("Invalid price or value in backup.");
      return v;
    };
    const volume = b.volume == null ? "" : String(b.volume);
    if (volume !== "" && (!/^\d+$/.test(volume) || volume.length > 8)) throw new Error("Invalid volume in backup.");
    if (b.image && !isSafeImage(b.image)) throw new Error("Invalid cover image in backup.");
    if (b.spineImage && !isSafeImage(b.spineImage)) throw new Error("Invalid spine image in backup.");
    return {
      id, title, author: cleanText(b.author, 100), series: cleanText(b.series, 100),
      volume, pricePaid: numberOrNull(b.pricePaid), originalPrice: numberOrNull(b.originalPrice), estimatedValue: numberOrNull(b.estimatedValue),
      status, image: b.image || "", color: /^#[0-9a-fA-F]{6}$/.test(b.color || "") ? b.color : "#53677a",
      spineImage: b.spineImage || "",
      spineText: cleanText(b.spineText, 80),
      spineColor: /^#[0-9a-fA-F]{6}$/.test(b.spineColor || "") ? b.spineColor : (/^#[0-9a-fA-F]{6}$/.test(b.color || "") ? b.color : "#53677a")
    };
  });
}
$("import-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 30 * 1024 * 1024) throw new Error("Backup file is over 30 MB. Browser storage may be too small.");
    const parsed = JSON.parse(await file.text());
    const incoming = validateBackup(parsed);
    if (!confirm(`Import ${incoming.length} books? This REPLACES all ${books.length} books currently saved in this browser. Export your current backup first if you want to keep them.`)) return;
    saveLibrary(incoming); // localStorage must succeed before in-memory books change
    showMessage(`Imported ${incoming.length} books successfully. Your previous browser collection was replaced.`);
  } catch (error) {
    showMessage(`Import failed: ${error.message}. Your existing collection was not changed.`);
  } finally { event.target.value = ""; }
});


/* Simple image-link previews — no book metadata lookup. */
// Preview a cover URL before saving. Some sites block hotlinked images.
const urlInput = $("book-cover-url");
const previewPanel = $("cover-preview");
const previewImage = $("cover-preview-image");
const previewMessage = $("cover-preview-message");
function updateCoverPreview() {
  const value = urlInput.value.trim();
  previewPanel.hidden = !value;
  previewImage.hidden = true;
  previewImage.removeAttribute("src");
  if (!value) return;
  if (!isSafeImage(value)) {
    previewMessage.textContent = "Enter a direct HTTPS JPG, PNG or WebP image URL — an Amazon product page won't work.";
    return;
  }
  previewMessage.textContent = "Checking image...";
  previewImage.onload = () => {
    previewImage.hidden = false;
    previewMessage.textContent = "Cover image loaded. Save the book to use it.";
  };
  previewImage.onerror = () => {
    previewImage.hidden = true;
    previewMessage.textContent = "This website isn't allowing the cover to load. Try uploading the image file instead.";
  };
  previewImage.src = value;
}
urlInput.addEventListener("change", updateCoverPreview);
urlInput.addEventListener("blur", updateCoverPreview);

// If old saved data cannot be read, do not allow writes to overwrite it.
try {
  books = readLibrary();
  restorePreferences();
  render();
} catch (error) {
  $("add-book").disabled = true;
  $("import-books").disabled = true;
  $("export-books").disabled = true;
  render();
}
