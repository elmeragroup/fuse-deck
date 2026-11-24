/**
 * The renderer's entry. It finds its host before the router reads the address, because the
 * browser-tab harness carries its bootstrap credential in the fragment and removes it first.
 */

import { StrictMode } from "react";

import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";

import { LocaleProvider } from "@elmeragroup/fuse/theme";

import { detectHost } from "./host.ts";
import { createStudioRouter } from "./router.ts";
import { startStudioClient } from "./state/studio-client.ts";
import { StudioClientContext } from "./state/use-studio.ts";
import "./studio.css";

const client = startStudioClient(detectHost());
const router = createStudioRouter();

const container = document.getElementById("studio");
if (container === null) {
  throw new Error("The studio page has no #studio element.");
}

createRoot(container).render(
  <StrictMode>
    <LocaleProvider locale="en-US">
      <StudioClientContext value={client}>
        <RouterProvider router={router} />
      </StudioClientContext>
    </LocaleProvider>
  </StrictMode>
);
