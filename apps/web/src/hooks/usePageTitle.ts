import { useEffect } from 'react';
import { APP_NAME } from '../config';

/** Unique page titles (A9). */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} | ${APP_NAME}`;
  }, [title]);
}
