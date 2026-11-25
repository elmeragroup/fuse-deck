import { Component } from "react";
import type { ReactNode } from "react";

import { Alert } from "@elmeragroup/fuse/alert";

/** What the boundary shows: its children, or why they could not be drawn. */
type BoundaryState = { readonly failed: string | null };

/**
 * A render error in its children shows here as a notice instead of unmounting the page, so a chat
 * entry or a diff that cannot be drawn never takes the workspace or the Source draft with it.
 * React catches render errors only in a class component's `getDerivedStateFromError`.
 */
export class RenderBoundary extends Component<
  {
    /** What the children show, for the notice: "The agent chat", say. */
    readonly label: string;
    readonly children: ReactNode;
  },
  BoundaryState
> {
  /** No error yet. */
  override state: BoundaryState = { failed: null };

  /**
   * The state after a child's render error.
   *
   * @param error - What the child threw.
   * @returns The state that shows the notice.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- React hands over whatever a child threw
  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { failed: error instanceof Error ? error.message : String(error) };
  }

  /**
   * The children, or the notice.
   *
   * @returns The rendered content.
   */
  override render(): ReactNode {
    if (this.state.failed === null) {
      return this.props.children;
    }
    return (
      <Alert.Root variant="destructive" role="alert">
        <Alert.Title level={3}>{this.props.label} could not be shown</Alert.Title>
        <Alert.Description>{this.state.failed}</Alert.Description>
      </Alert.Root>
    );
  }
}
