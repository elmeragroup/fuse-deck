import { statusText } from "../state/status-text.ts";
import { useStudio } from "../state/use-studio.ts";

/** The status line, and the last notice. Screen readers hear both as they change. */
export function StudioStatus() {
  const { snapshot } = useStudio();
  return (
    <div className="studio-status">
      <p role="status" className="studio-status-line">
        {statusText(snapshot.connection)}
      </p>
      <p aria-live="polite" className="studio-notice">
        {snapshot.notice ?? ""}
      </p>
    </div>
  );
}
