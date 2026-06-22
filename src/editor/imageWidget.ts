import { WidgetType } from '@codemirror/view';
import type { AssetUrlResolver } from '../types';

export class ImageWidget extends WidgetType {
    filename: string;
    width: number | null;
    getAssetUrl: AssetUrlResolver;

    constructor(filename: string, width: number | null, getAssetUrl: AssetUrlResolver) {
        super();
        this.filename = filename;
        this.width = width;
        this.getAssetUrl = getAssetUrl;
    }

    eq(other: ImageWidget): boolean {
        return (
            other.filename === this.filename &&
            other.width === this.width &&
            other.getAssetUrl === this.getAssetUrl
        );
    }

    toDOM(): HTMLElement {
        const container = document.createElement('span');
        container.className = 'cm-image-widget';

        const wrapper = document.createElement('span');
        wrapper.className = 'cm-image-wrapper';

        // Show a loading text while we see if the file exists
        const img = document.createElement('img');
        img.style.display = 'none';

        const placeholder = document.createElement('span');
        placeholder.className = 'cm-image-placeholder';
        placeholder.textContent = `Loading ${this.filename}...`;

        wrapper.appendChild(placeholder);
        wrapper.appendChild(img);
        container.appendChild(wrapper);

        this.getAssetUrl(this.filename).then((url) => {
            if (url) {
                img.src = url;
                img.style.display = 'block';
                // Apply width if provided (e.g. 200 from | 200)
                if (this.width) {
                    img.style.width = this.width + 'px';
                }
                placeholder.style.display = 'none';
            } else {
                placeholder.textContent = `Image not found: ${this.filename}`;
                placeholder.classList.add('error');
            }
        });

        return container;
    }
}
