// Attachments live in a private Blob Storage container. The Function App signs
// in with its managed identity (Storage Blob Data Contributor role).
const { BlobServiceClient } = require("@azure/storage-blob");
const { DefaultAzureCredential } = require("@azure/identity");

let container;

function getContainer() {
  if (!container) {
    const service = new BlobServiceClient(
      `https://${process.env.STORAGE_ACCOUNT}.blob.core.windows.net`,
      new DefaultAzureCredential()
    );
    container = service.getContainerClient(process.env.ATTACHMENTS_CONTAINER || "attachments");
  }
  return container;
}

async function uploadFile(blobPath, buffer, contentType) {
  await getContainer()
    .getBlockBlobClient(blobPath)
    .uploadData(buffer, { blobHTTPHeaders: { blobContentType: contentType } });
}

async function downloadFile(blobPath) {
  return getContainer().getBlobClient(blobPath).downloadToBuffer();
}

// The file plus its content type and ETag, or null when there is no such file.
async function downloadWithProperties(blobPath) {
  try {
    const response = await getContainer().getBlobClient(blobPath).download();
    const chunks = [];
    for await (const chunk of response.readableStreamBody) chunks.push(chunk);
    return { buffer: Buffer.concat(chunks), contentType: response.contentType, etag: response.etag };
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

async function deleteFile(blobPath) {
  await getContainer().getBlobClient(blobPath).deleteIfExists();
}

module.exports = { uploadFile, downloadFile, downloadWithProperties, deleteFile };
