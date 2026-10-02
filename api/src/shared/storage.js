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

module.exports = { uploadFile, downloadFile };
