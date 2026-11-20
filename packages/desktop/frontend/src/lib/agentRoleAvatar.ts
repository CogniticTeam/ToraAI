function avatarDimensions(bytes: Uint8Array, type: string): [number, number] | null {
	const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
	if (type === 'image/png') {
		if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) || text(12) !== 'IHDR') return null;
		return [data.getUint32(16), data.getUint32(20)];
	}
	if (type === 'image/jpeg') {
		if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
		let offset = 2;
		while (offset + 3 < bytes.length) {
			if (bytes[offset] !== 0xff) return null;
			while (bytes[offset] === 0xff) offset++;
			const marker = bytes[offset++];
			if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) return null;
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
			const length = data.getUint16(offset);
			if (length < 2 || offset + length > bytes.length) return null;
			if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
				return length >= 8 ? [data.getUint16(offset + 5), data.getUint16(offset + 3)] : null;
			}
			offset += length;
		}
		return null;
	}
	if (bytes.length < 12 || text(0) !== 'RIFF' || text(8) !== 'WEBP' || data.getUint32(4, true) + 8 > bytes.length) return null;
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const chunk = text(offset), length = data.getUint32(offset + 4, true), start = offset + 8;
		if (start + length > bytes.length) return null;
		if (chunk === 'VP8X' && length >= 10) {
			const uint24 = (index: number) => bytes[index] | (bytes[index + 1] << 8) | (bytes[index + 2] << 16);
			return [uint24(start + 4) + 1, uint24(start + 7) + 1];
		}
		if (chunk === 'VP8L' && length >= 5 && bytes[start] === 0x2f) {
			const bits = data.getUint32(start + 1, true);
			return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
		}
		if (chunk === 'VP8 ' && length >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
			return [data.getUint16(start + 6, true) & 0x3fff, data.getUint16(start + 8, true) & 0x3fff];
		}
		offset = start + length + (length % 2);
	}
	return null;
}

export async function readRoleAvatar(file: File): Promise<string> {
	if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new RangeError('Invalid avatar file');
	const dimensions = avatarDimensions(new Uint8Array(await file.arrayBuffer()), file.type);
	if (!dimensions || dimensions[0] < 1 || dimensions[1] < 1 || dimensions[0] * dimensions[1] > 16_000_000) throw new RangeError('Invalid avatar dimensions');
	const image = await createImageBitmap(file);
	try {
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 128;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Image conversion unavailable');
		const edge = Math.min(image.width, image.height);
		context.drawImage(image, (image.width - edge) / 2, (image.height - edge) / 2, edge, edge, 0, 0, 128, 128);
		return canvas.toDataURL('image/png');
	} finally { image.close(); }
}
