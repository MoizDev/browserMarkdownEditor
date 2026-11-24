// Only serializes objects this writer creates. It is deliberately not a PDF parser.
const encoder = new TextEncoder();
const MAX_OUTPUT = 0x7fffffff;

export function pdfNumber(value: number): string {
    if (!Number.isFinite(value) || Math.abs(value) > 1e15) throw new RangeError('PDF coordinate is outside the supported range');
    if (Object.is(value, -0) || value === 0) return '0';
    const text = String(value);
    if (!/[eE]/.test(text)) return text;
    const [mantissa, exponentText] = text.toLowerCase().split('e');
    const exponent = Number(exponentText);
    const sign = mantissa.startsWith('-') ? '-' : '';
    const digits = mantissa.replace('-', '').replace('.', '');
    const point = (mantissa.replace('-', '').indexOf('.') < 0 ? digits.length : mantissa.replace('-', '').indexOf('.')) + exponent;
    if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
    if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
    return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function encoded(value: string): Uint8Array { return encoder.encode(value); }

/** Byte offsets and stream lengths are calculated from encoded bytes, never JS string length. */
export class PdfObjects {
    private readonly objects: Array<Uint8Array | undefined> = [];

    reserve(): number { this.objects.push(undefined); return this.objects.length; }
    add(value: string): number { const id = this.reserve(); this.set(id, value); return id; }
    set(id: number, value: string): void { this.put(id, encoded(value)); }
    stream(dictionary: string, data: Uint8Array): number {
        const id = this.reserve();
        this.put(id, join([encoded(`<< ${dictionary} /Length ${data.byteLength} >>\nstream\n`), data, encoded('\nendstream')]));
        return id;
    }
    private put(id: number, value: Uint8Array): void {
        if (!Number.isSafeInteger(id) || id < 1 || id > this.objects.length || this.objects[id - 1]) throw new Error('Invalid PDF object assignment');
        this.objects[id - 1] = value;
    }
    finish(root: number): Uint8Array {
        const chunks: Uint8Array[] = [encoded('%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n')];
        const offsets = [0];
        let size = chunks[0].length;
        this.objects.forEach((object, i) => {
            if (!object) throw new Error('Unassigned PDF object');
            offsets.push(size);
            const parts = [encoded(`${i + 1} 0 obj\n`), object, encoded('\nendobj\n')];
            for (const part of parts) { size += part.length; if (!Number.isSafeInteger(size) || size > MAX_OUTPUT) throw new RangeError('PDF output is too large'); chunks.push(part); }
        });
        const xref = size;
        const entries = offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
        chunks.push(encoded(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${offsets.length} /Root ${root} 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
        return join(chunks);
    }
}

export function join(chunks: readonly Uint8Array[]): Uint8Array {
    let total = 0;
    for (const chunk of chunks) { total += chunk.byteLength; if (!Number.isSafeInteger(total) || total > MAX_OUTPUT) throw new RangeError('PDF output is too large'); }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
}

export function ascii(value: string): Uint8Array { return encoded(value); }
