import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIcon } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';
import { version, productName } from '../../../../package.json';
import { DashboardService } from '../services/dashboard.service';

@Component({
  selector: 'app-about-view',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatIcon,
    MatCheckboxModule,
    FormsModule,
    MatRadioModule,
  ],
  templateUrl: './about-view.component.html',
  styleUrl: './about-view.component.css',
})
export class AboutViewComponent {
  version: string;
  HWVersion: string = 'Not Connected';
  ProductName: string = 'PGY MIL Protocol Analyzer';

  constructor(
    public dialogRef: MatDialogRef<AboutViewComponent>,
    dashboardService: DashboardService,
  ) {
    this.version = version;
    this.HWVersion = dashboardService.HWVersion;
    this.ProductName = productName || this.ProductName;
  }

  onNoClick(): void {
    this.dialogRef.close();
  }
}
