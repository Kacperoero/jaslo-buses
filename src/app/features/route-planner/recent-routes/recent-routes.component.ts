import { Component, inject } from '@angular/core';
import { FavoritesService, RecentRoute } from '../../../core/services/favorites.service';
import { PlannerStateService } from '../planner-state.service';

/** Recently searched routes – one click fills A and B and searches again. */
@Component({
  selector: 'app-recent-routes',
  standalone: true,
  templateUrl: './recent-routes.component.html',
  styleUrl: './recent-routes.component.scss'
})
export class RecentRoutesComponent {
  readonly favorites = inject(FavoritesService);
  private planner = inject(PlannerStateService);

  use(route: RecentRoute): void {
    this.planner.useRecentRoute(route);
  }

  remove(route: RecentRoute, event: Event): void {
    event.stopPropagation();
    this.favorites.removeRecentRoute(route);
  }
}
