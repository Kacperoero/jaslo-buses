import { Component } from '@angular/core';
import { MainMapComponent } from './main-map/main-map.component';

@Component({
  selector: 'app-root',
  imports: [MainMapComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {}
