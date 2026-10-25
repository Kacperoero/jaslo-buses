import { Component, HostListener, effect, inject, signal, untracked } from '@angular/core';
import { ShapesService } from '../../core/services/shapes.service';
import { MapMarkerService } from '../map/services/map-marker.service';
import { StopEditorLayerService } from './stop-editor-layer.service';
import { EditorFilter, StopEditorService, timetableDirections } from './stop-editor.service';

/** Developer panel (app opened with ?dev): walk through the stops and set their directions. */
@Component({
  selector: 'app-stop-editor',
  standalone: true,
  templateUrl: './stop-editor.component.html',
  styleUrl: './stop-editor.component.scss'
})
export class StopEditorComponent {
  readonly editor = inject(StopEditorService);
  private layer = inject(StopEditorLayerService);
  private shapes = inject(ShapesService);
  private markers = inject(MapMarkerService);

  readonly timetableDirections = timetableDirections;
  readonly copied = signal(false);
  readonly filters: { value: EditorFilter; label: string }[] = [
    { value: 'unchecked', label: 'Niesprawdzone' },
    { value: 'changed', label: 'Zmienione' },
    { value: 'all', label: 'Wszystkie' }
  ];

  constructor() {
    this.editor.start();
    effect(() => {
      const stop = this.editor.current();
      const position = this.editor.currentPosition();
      const roadPoints = this.editor.currentRoadPoints();
      this.shapes.loaded(); // redraw once the road lines arrive
      untracked(() => this.layer.show(stop && position ? {
        stop, position, roadPoints,
        onMoveStop: (lat, lng) => this.editor.moveStop(lat, lng),
        onMoveRoadPoint: (i, lat, lng) => this.editor.moveRoadPoint(i, lat, lng)
      } : null));
    });
    // Clicking a stop on the map makes it the current one
    effect(() => {
      const id = this.markers.selectedStopId();
      if (id) untracked(() => this.editor.go(id));
    });
  }

  short(name: string | undefined): string {
    return (name ?? '').replace('JASŁO,ul.', '');
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    const actions: Record<string, () => void> = {
      ArrowRight: () => this.editor.next(),
      ArrowLeft: () => this.editor.prev(),
      '1': () => this.editor.setDirections(1),
      '2': () => this.editor.setDirections(2),
      Enter: () => this.editor.confirmAndNext()
    };
    const action = actions[e.key];
    if (!action) return;
    e.preventDefault();
    action();
  }

  download(): void {
    const url = URL.createObjectURL(new Blob([this.editor.exportJson()], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stop-overrides.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async copy(): Promise<void> {
    await navigator.clipboard.writeText(this.editor.exportJson());
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }
}
