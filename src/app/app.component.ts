import {
  Component,
  HostListener
} from '@angular/core';

import { CommonModule } from '@angular/common';
import { HttpClientModule } from '@angular/common/http';
import { RouterOutlet } from '@angular/router';

import { MatTableModule } from '@angular/material/table';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

import { ScrollingModule } from '@angular/cdk/scrolling';

import { MenuBarComponent } from './features/dashboard/components/menu-bar/menu-bar.component';
import { ToolBarComponent } from './features/dashboard/components/tool-bar/tool-bar.component';
import { BusConfigurationComponent } from './features/dashboard/components/bus-configuration/bus-configuration.component';
import { PostAnalysisComponent } from './features/dashboard/components/post-analysis/post-analysis.component';
import { BusDataGridComponent } from './features/dashboard/components/bus-data-grid/bus-data-grid.component';
import { TriggerConfigurationComponent } from './features/dashboard/components/trigger-configuration/trigger-configuration.component';
import { PlotViewComponent } from './features/plot-view/plot-view.component';
import { ImportSectionComponent } from './features/import-section/import-section.component';
import { DisplaySectionComponent } from './features/display-section/display-section.component';
import { ExportSectionComponent } from './features/export-section/export-section.component';
import { DashboardModel } from './features/dashboard/models/dashboard.model';
import { DashboardService } from './features/services/dashboard.service';

export type ResizeSide = 'left' | 'right' | 'center';

@Component({
  selector: 'app-root',

  standalone: true,

  imports: [
    CommonModule,
    HttpClientModule,

    RouterOutlet,

    MatTableModule,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,

    ScrollingModule,

    MenuBarComponent,
    ToolBarComponent,
    BusConfigurationComponent,
    PostAnalysisComponent,
    BusDataGridComponent,
    TriggerConfigurationComponent,
    PlotViewComponent,
    ImportSectionComponent,
    DisplaySectionComponent,
    ExportSectionComponent,

  ],

  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})

export class AppComponent {

  // =====================================================
  // THEME
  // =====================================================

  isDarkMode = false;


  // =====================================================
  // DEVICE MODE
  // =====================================================

  selecteddevicemode = 'Default';


  // =====================================================
  // TOOLBAR STATE
  // =====================================================

  workAreaZoom = 100;

  showGrid = true;

  isTableView = false;

  selectedTool = 'mouse';

  isAcquisitionRunning = false;

  selectedFileName = '';

  searchText = '';


  // =====================================================
  // PANEL RESIZE
  // =====================================================

  leftPanelWidth = 290;

  rightPanelWidth = 300;

  busGridHeight = 280;

  isResizing = false;

  resizeSide: ResizeSide | null = null;


  // =====================================================
  // PANEL SIZE LIMITS
  // =====================================================

  private readonly MIN_LEFT_PANEL_WIDTH = 220;

  private readonly MIN_RIGHT_PANEL_WIDTH = 260;

  private readonly MIN_CENTER_PANEL_WIDTH = 300;

  private readonly MIN_PLOT_HEIGHT = 120;

  private readonly MIN_BUS_GRID_HEIGHT = 160;

  private readonly CENTER_RESIZE_HANDLE_HEIGHT = 7;


  // =====================================================
  // INITIALIZATION
  // =====================================================

  constructor(
    public dashboardModel: DashboardModel,
    private readonly dashboardService: DashboardService
  ) {
    this.applyTheme(false);
  }


  // =====================================================
  // MENU SELECTION
  // =====================================================

  onSelectionChange(selection: any): void {

    console.log(
      'Selection changed:',
      selection
    );

    if (
      selection &&
      selection.selectedMode
    ) {

      this.selecteddevicemode =
        selection.selectedMode;

    }

  }


  // =====================================================
  // DEFAULT SELECTION
  // =====================================================

  OnSelectionDefaultChange(selection: any): void {

    console.log(
      'Default selection:',
      selection
    );

  }


  // =====================================================
  // DARK / LIGHT MODE
  // =====================================================

  toggleDarkMode(): void {

    this.isDarkMode =
      !this.isDarkMode;

    this.applyTheme(
      this.isDarkMode
    );

  }


  // =====================================================
  // GLOBAL THEME
  // =====================================================

  private applyTheme(
    dark: boolean
  ): void {

    const html =
      document.documentElement;

    const body =
      document.body;

    const appRoot =
      document.querySelector('app-root');


    // Remove old theme classes
    html.classList.remove(
      'dark-mode',
      'light-mode',
      'dark-theme',
      'light-theme'
    );

    body.classList.remove(
      'dark-mode',
      'light-mode',
      'dark-theme',
      'light-theme'
    );

    if (appRoot) {

      appRoot.classList.remove(
        'dark-mode',
        'light-mode',
        'dark-theme',
        'light-theme'
      );

    }


    // =================================================
    // DARK MODE
    // =================================================

    if (dark) {

      html.classList.add(
        'dark-mode'
      );

      body.classList.add(
        'dark-mode'
      );

      if (appRoot) {

        appRoot.classList.add(
          'dark-mode'
        );

      }

    }


    // =================================================
    // LIGHT MODE
    // =================================================

    else {

      html.classList.add(
        'light-mode'
      );

      body.classList.add(
        'light-mode'
      );

      if (appRoot) {

        appRoot.classList.add(
          'light-mode'
        );

      }

    }

  }


  // =====================================================
  // START PANEL RESIZE
  // =====================================================

  startResize(
    side: ResizeSide,
    event: MouseEvent
  ): void {

    event.preventDefault();

    event.stopPropagation();

    this.isResizing = true;

    this.resizeSide = side;

    document.body.style.cursor =
      side === 'center'
        ? 'row-resize'
        : 'col-resize';

    document.body.style.userSelect = 'none';

  }


  // =====================================================
  // HANDLE MOUSE MOVE
  // =====================================================

  @HostListener(
    'document:mousemove',
    ['$event']
  )
  onResizeMove(
    event: MouseEvent
  ): void {

    if (
      !this.isResizing ||
      !this.resizeSide
    ) {

      return;

    }


    // =================================================
    // CENTER PANEL VERTICAL RESIZE
    // (plot view vs bus data grid)
    // =================================================

    if (
      this.resizeSide === 'center'
    ) {

      this.resizeCenterSplit(event);

      return;

    }


    const mainLayout =
      document.querySelector(
        '.main-layout'
      ) as HTMLElement | null;


    if (!mainLayout) {

      return;

    }


    const rect =
      mainLayout.getBoundingClientRect();


    // =================================================
    // LEFT PANEL RESIZE
    // =================================================

    if (
      this.resizeSide === 'left'
    ) {

      const newWidth =
        event.clientX -
        rect.left;


      const maxWidth =
        rect.width -
        this.rightPanelWidth -
        this.MIN_CENTER_PANEL_WIDTH;


      this.leftPanelWidth =
        this.clamp(
          newWidth,
          this.MIN_LEFT_PANEL_WIDTH,
          maxWidth
        );

    }


    // =================================================
    // RIGHT PANEL RESIZE
    // =================================================

    if (
      this.resizeSide === 'right'
    ) {

      const newWidth =
        rect.right -
        event.clientX;


      const maxWidth =
        rect.width -
        this.leftPanelWidth -
        this.MIN_CENTER_PANEL_WIDTH;


      this.rightPanelWidth =
        this.clamp(
          newWidth,
          this.MIN_RIGHT_PANEL_WIDTH,
          maxWidth
        );

    }

  }


  // =====================================================
  // CENTER SPLIT (PLOT / GRID)
  // =====================================================

  private resizeCenterSplit(
    event: MouseEvent
  ): void {

    const centerContent =
      document.querySelector(
        '.center-content'
      ) as HTMLElement | null;


    if (!centerContent) {

      return;

    }


    const rect =
      centerContent.getBoundingClientRect();


    const newHeight =
      rect.bottom -
      event.clientY;


    const maxHeight =
      rect.height -
      this.MIN_PLOT_HEIGHT -
      this.CENTER_RESIZE_HANDLE_HEIGHT;


    this.busGridHeight =
      this.clamp(
        newHeight,
        this.MIN_BUS_GRID_HEIGHT,
        maxHeight
      );

  }


  // =====================================================
  // STOP PANEL RESIZE
  // =====================================================

  @HostListener(
    'document:mouseup'
  )
  stopResize(): void {

    if (!this.isResizing) {

      return;

    }

    this.isResizing = false;

    this.resizeSide = null;

    document.body.style.cursor = '';

    document.body.style.userSelect = '';

  }


  // =====================================================
  // CLAMP VALUE
  // =====================================================

  private clamp(
    value: number,
    min: number,
    max: number
  ): number {

    if (max < min) {

      return min;

    }

    return Math.min(
      Math.max(
        value,
        min
      ),
      max
    );

  }


  // =====================================================
  // WINDOW RESIZE
  // =====================================================

  @HostListener(
    'window:resize'
  )
  onWindowResize(): void {

    const mainLayout =
      document.querySelector(
        '.main-layout'
      ) as HTMLElement | null;


    if (!mainLayout) {

      return;

    }


    const rect =
      mainLayout.getBoundingClientRect();


    const maxLeftWidth =
      rect.width -
      this.rightPanelWidth -
      this.MIN_CENTER_PANEL_WIDTH;


    const maxRightWidth =
      rect.width -
      this.leftPanelWidth -
      this.MIN_CENTER_PANEL_WIDTH;


    this.leftPanelWidth =
      this.clamp(
        this.leftPanelWidth,
        this.MIN_LEFT_PANEL_WIDTH,
        Math.max(
          this.MIN_LEFT_PANEL_WIDTH,
          maxLeftWidth
        )
      );


    this.rightPanelWidth =
      this.clamp(
        this.rightPanelWidth,
        this.MIN_RIGHT_PANEL_WIDTH,
        Math.max(
          this.MIN_RIGHT_PANEL_WIDTH,
          maxRightWidth
        )
      );


    this.clampBusGridHeight();

  }


  // =====================================================
  // CLAMP BUS GRID HEIGHT
  // =====================================================

  private clampBusGridHeight(): void {

    const centerContent =
      document.querySelector(
        '.center-content'
      ) as HTMLElement | null;


    if (!centerContent) {

      return;

    }


    const rect =
      centerContent.getBoundingClientRect();


    const maxHeight =
      rect.height -
      this.MIN_PLOT_HEIGHT -
      this.CENTER_RESIZE_HANDLE_HEIGHT;


    this.busGridHeight =
      this.clamp(
        this.busGridHeight,
        this.MIN_BUS_GRID_HEIGHT,
        Math.max(
          this.MIN_BUS_GRID_HEIGHT,
          maxHeight
        )
      );

  }

}
