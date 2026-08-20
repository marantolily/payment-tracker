const MAX_PHOTO_BYTES = 300 * 1024;
const MAX_DIMENSION = 1600;

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image"));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function scaleDimensions(width, height, maxDim) {
  if (width <= maxDim && height <= maxDim) {
    return { width, height };
  }

  const ratio = Math.min(maxDim / width, maxDim / height);
  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
  };
}

async function compressImageFile(file) {
  const img = await loadImageFromFile(file);
  let maxDim = MAX_DIMENSION;
  let quality = 0.82;

  while (maxDim >= 400) {
    const { width, height } = scaleDimensions(img.width, img.height, maxDim);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);

    let blob = await canvasToBlob(canvas, "image/jpeg", quality);

    while (blob && blob.size > MAX_PHOTO_BYTES && quality > 0.35) {
      quality -= 0.08;
      blob = await canvasToBlob(canvas, "image/jpeg", quality);
    }

    if (blob && blob.size <= MAX_PHOTO_BYTES) {
      return blobToDataUrl(blob);
    }

    maxDim = Math.round(maxDim * 0.75);
    quality = 0.82;
  }

  const { width, height } = scaleDimensions(img.width, img.height, 400);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0, width, height);
  const blob = await canvasToBlob(canvas, "image/jpeg", 0.35);
  return blobToDataUrl(blob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function compressImageFiles(files) {
  return Promise.all(files.map((file) => compressImageFile(file)));
}

function formatPhotoSize(dataUrl) {
  const base64 = dataUrl.split(",")[1] || "";
  const bytes = Math.round((base64.length * 3) / 4);
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}
