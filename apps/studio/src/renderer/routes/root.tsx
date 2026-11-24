import { createRootRoute, Outlet } from "@tanstack/react-router";

import { StudioStatus } from "../components/studio-status.tsx";

/** The shell every view sits in: the view, then the status line. */
function RootLayout() {
  return (
    <div className="studio-shell">
      <Outlet />
      <StudioStatus />
    </div>
  );
}

/** The root route. */
export const rootRoute = createRootRoute({ component: RootLayout });
