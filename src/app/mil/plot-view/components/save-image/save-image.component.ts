import { AfterViewInit, Component, ElementRef, Inject, Output, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIcon } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CoreService } from '../../../../core/services/core.services';
import { FileFilter } from '../../../../core/services/file.service';

@Component({
  standalone: true,
  selector: 'app-save-image',
  templateUrl: './save-image.component.html',
  styleUrls: ['./save-image.component.css'],
  imports: [MatIcon, FormsModule, MatButtonModule, MatDialogModule, MatInputModule, MatTooltipModule],
})
export class SaveImageComponent implements AfterViewInit {
  filePath: string = 'Images';
  fileName: string = 'test.png';

  @ViewChild('folderInput') folderInput!: ElementRef;
  @Output() saveEnabled: boolean = true;

  constructor(
    public coreService: CoreService,
    public dialogRef: MatDialogRef<SaveImageComponent>,
    @Inject(MAT_DIALOG_DATA) public data: any
  ) {}

  async ngAfterViewInit(): Promise<void> {
    try {
      const home = await this.coreService.PathService.getAppHome();
      const absolutePath = this.coreService.PathService.combine(home, 'Images');
      this.filePath = absolutePath;
      await this.coreService.FileService.EnsureDirectoryExist(this.filePath);
    } catch (error) {
      console.error('Error occurred while resolving absolute path:', error);
    }
  }

  async browseAndSave() {
    try {
      const response = await this.coreService.FileService.SaveFileBrowseSelection({
        Title: 'Select file to save plot ',
        ButtonTitle: 'Save Image',
        DefaultDirectory: this.filePath,
        Filters: [new FileFilter('SVG Images', ['svg']), new FileFilter('PNG Images', ['png'])],
      });

      if (response.Success) {
        this.fileName = response.SelectedFile;
        await this.ok();
      }
    } catch (error) {
      console.error('Error occurred saving trace.', error);
    }
  }

  async btnBrowseClick(_event: unknown) {
    try {
      const response = await this.coreService.FileService.FolderBrowseSelection(this.filePath);
      if (response.Success) {
        const fullPath = response.Selection[0];
        if (fullPath) {
          this.filePath = fullPath;
        }
      }
    } catch (error) {
      console.error(error);
    }
  }

  async saveNow() {
    try {
      const timestamp = this.getCurrentTimestamp();
      this.fileName = `image_${timestamp}.png`;
      await this.ok();
    } catch (error) {
      console.error('Error occurred saving Image.', error);
    }
  }

  private getCurrentTimestamp(): string {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[now.getMonth()];
    const year = now.getFullYear();

    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;

    const formattedHours = String(hours).padStart(2, '0');

    return `${day}-${month}-${year}_at_${formattedHours}-${minutes}-${seconds}_${ampm}`;
  }

  ok(): void {
    this.dialogRef.close({
      filePath: this.filePath,
      fileName: this.fileName,
    });
  }

  onNoClick(): void {
    this.dialogRef.close();
  }

  triggerFileInput(): void {
    this.folderInput.nativeElement.click();
  }

  onClose(): void {
    this.dialogRef.close();
  }
}
