export const SUPPORTED_IMAGE_MIME_TYPES: readonly string[] = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
];

export const MAX_IMAGE_ATTACHMENTS = 3;
export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = Math.floor(2.5 * 1024 * 1024);
