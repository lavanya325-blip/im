import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface PlotImageRecord {
  imagePath: string;
  isIncluded: boolean;
  description: string;
  content?: string;
}

export interface PlotCaptureRequest {
  frameIndex: number;
  resolve: (image: string | undefined) => void;
}

@Injectable({ providedIn: 'root' })
export class ImageSessionService {
  private readonly images: PlotImageRecord[] = [];
  readonly captureRequest$ = new Subject<PlotCaptureRequest>();

  addImage(image: PlotImageRecord): void {
    const existing = this.images.find(item => item.imagePath === image.imagePath);
    if (existing) {
      existing.isIncluded = image.isIncluded;
      existing.description = image.description;
      return;
    }
    this.images.push({ ...image });
  }

  updateImageBase64(imagePath: string, content: string): void {
    const existing = this.images.find(item => item.imagePath === imagePath);
    if (existing) {
      existing.content = content;
    }
  }
}
