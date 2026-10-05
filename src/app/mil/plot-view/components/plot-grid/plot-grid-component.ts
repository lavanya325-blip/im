import { Component, ElementRef, ViewChild, Input, ChangeDetectionStrategy, OnDestroy, NO_ERRORS_SCHEMA, SimpleChanges, OnChanges, AfterViewInit } from '@angular/core';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CommonModule } from '@angular/common';
import { NumberFormat } from '../../../../shared/utils/number-format';
import { Subject, takeUntil } from 'rxjs';
import { ZoomStateService } from '../../services/zoom-state.service';
import * as d3 from 'd3';

@Component({
    selector: 'plot-grid',
    standalone: true,
    imports: [ScrollingModule, MatTooltipModule, CommonModule],
    templateUrl: './plot-grid-component.html',
    styleUrl: './plot-grid-component.css',
    changeDetection: ChangeDetectionStrategy.Default,
    schemas: [NO_ERRORS_SCHEMA]
})
export class PlotGrid implements AfterViewInit, OnDestroy, OnChanges {
    @ViewChild('gridsvg', { static: true }) gridsvg!: ElementRef<SVGElement>;


    private resizeObserver!: ResizeObserver;
    GridSize!: DOMRectReadOnly;

    NumberOfGridLines = 9; // Number of vertical grid lines
    GridLines: number[] = [];

    @Input() xScale?: d3.ScaleLinear<number, number>;
    @Input() TriggerTime: number = 0;
    @Input() Enabled: boolean = true;

    private textLabels: d3.Selection<SVGTextElement, number, SVGElement, unknown> | null = null;

    constructor(private zoomStateService: ZoomStateService) {
    }

    async ngOnChanges(changes: SimpleChanges) {
        if (changes['xScale'] || changes['TriggerTime'] || changes['Enabled']) {

            if (this.GridSize) {
                await this.generateGridLines();
                this.updateGridLabelText(this.xScale!);
            }
        }
    }

    async ngAfterViewInit() {
        this.GridSize = this.gridsvg.nativeElement.getBoundingClientRect();

        // Initialize ResizeObserver to monitor size changes
        this.resizeObserver = new ResizeObserver((entries) => {
            for (let entry of entries) {
                this.GridSize = entry.contentRect;
                this.generateGridLines();
            }
        });
        // Start observing the component element
        this.resizeObserver.observe(this.gridsvg.nativeElement);

        await this.generateGridLines();
        this.updateGridLabelText(this.xScale!);

        this.zoomStateService.transform$
            .pipe(takeUntil(this.destroy$))
            .subscribe(newTransform => {
                if (!this.gridsvg) return;

                const transformedScale = newTransform.rescaleX(this.xScale!);
                this.updateGridLabelText(transformedScale);
            });
    }

    private updateGridLabelText(scale: d3.ScaleLinear<number, number>) {
        if (!scale) {
            return;
        }
        // Use D3's .each() to loop through our cached text elements
        this.textLabels?.each((pixelX, i, nodes) => {
            // `pixelX` is the static pixel position (e.g., 150.5) that we bound
            // in generateGridLines. `i` is the index, and `nodes[i]` is the raw DOM element.

            // 3. Perform the inverse calculation to get the time value at that pixel position
            const dataValue = scale.invert(pixelX);

            // 4. Format the time string
            const timeString = `${NumberFormat.toEngineeringNotation(dataValue - this.TriggerTime, 3)}s`;

            // 5. Update the DOM element's text content DIRECTLY.
            nodes[i].textContent = timeString;
        });
    }

    private destroy$ = new Subject<void>();

    ngOnDestroy(): void {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }

        this.destroy$.next();
        this.destroy$.complete();
    }

    private async generateGridLines() {
        if (this.Enabled) {
            var clientRect = this.GridSize;

            // Generate positions for vertical grid lines
            const xStep = clientRect.width / (this.NumberOfGridLines + 1);
            this.GridLines = Array.from({ length: this.NumberOfGridLines }, (_, i) => (i + 1) * xStep);
        } else {
            this.GridLines = [];
        }

        // Use setTimeout to run this AFTER Angular finishes rendering the *ngFor
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!this.gridsvg) return;

        // Select all the text elements and bind their pixel positions (`d`) to them.
        this.textLabels = d3.select(this.gridsvg.nativeElement)
            .selectAll<SVGTextElement, number>("text.grid-label")
            .data(this.GridLines);

        this.updateGridLabelText(this.xScale!);
    }
}
