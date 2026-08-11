import { Observable } from 'app/utils/observable';

/**
 * The currently active search query that the Set Sockets dialog (sheet)
 * is working with in its "selecting sockets" state.
 */
export const setSocketsQuery$ = new Observable<string | undefined>(undefined);

/**
 * Show the "Set Sockets" dialog (sheet).
 */
export function setSockets(query: string) {
  setSocketsQuery$.next(query);
}
