import { Component, input, output } from '@angular/core';
import { Connection } from '../route-planner.models';

/** One suggested connection in the planner results: line(s), times and the steps to take. */
@Component({
  selector: 'app-connection-card',
  standalone: true,
  templateUrl: './connection-card.component.html',
  styleUrl: './connection-card.component.scss',
  host: {
    role: 'button',
    tabindex: '0',
    '[attr.aria-pressed]': 'selected()',
    '(click)': 'chosen.emit()',
    '(keydown.enter)': 'chosen.emit()',
    '(keydown.space)': '$event.preventDefault(); chosen.emit()'
  }
})
export class ConnectionCardComponent {
  readonly conn = input.required<Connection>();
  readonly selected = input(false);
  /** The card was clicked / activated with the keyboard */
  readonly chosen = output<void>();
}
