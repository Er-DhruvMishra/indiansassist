/** /download#t= redirects client side to /join, preserving the fragment or query (contracts section 3.6). */
import { Navigate, useLocation } from 'react-router';

export function DownloadRedirect() {
  const loc = useLocation();
  return <Navigate replace to={{ pathname: '/join', hash: loc.hash, search: loc.search }} />;
}
