// image-session.service.ts
import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

export interface ReportImage {
  imagePath: string;
  base64?: string;
  isIncluded: boolean;
  description: string;
}

@Injectable({ providedIn: 'root' })
export class ImageSessionService {
  private imageListSubject = new BehaviorSubject<ReportImage[]>([]);
  imageList$ = this.imageListSubject.asObservable();
  private imageList: ReportImage[] = [];
    imageSaveFolder: string = '';

  addImage(image: ReportImage) {
    this.imageList = [...this.imageList, image];
    this.imageListSubject.next(this.imageList);
  }

  updateImageBase64(path: string, base64: string) {
    const index = this.imageList.findIndex(i => i.imagePath === path);
    if (index !== -1) {
      const updated = { ...this.imageList[index], base64 };
      this.imageList = [
        ...this.imageList.slice(0, index),
        updated,
        ...this.imageList.slice(index + 1)
      ];
      this.imageListSubject.next(this.imageList);
    }
  }

  clearImages() {
    this.imageList = [];
    this.imageListSubject.next(this.imageList);
  }

  getImages(): ReportImage[] {
    return [...this.imageList];
  }

  private captureRequest = new Subject<{
    frameIndex: number;
    resolve: (img: string | undefined) => void;
  }>();

  captureRequest$ = this.captureRequest.asObservable();

  requestCapture(frameIndex: number): Promise<string | undefined> {
    return new Promise(resolve => {
      let finished = false;
      const timeout = setTimeout(() => {
        if (!finished) {
          finished = true;
          resolve(undefined);
        }
      }, 8000);
      this.captureRequest.next({
        frameIndex,
        resolve: (img: string | undefined) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          resolve(img);
        }
      });
    });
  }
}
