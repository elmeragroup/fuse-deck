import { useCallback, useEffect, useRef, useState } from "react";
import type { TransitionEvent } from "react";

import { createPortal } from "react-dom";

import { Button } from "@elmeragroup/fuse/button";
import { Play, X } from "@elmeragroup/fuse/icons";

/**
 * Lifecycle of the full-canvas video stage:
 * - `idle`: the `<video>` is unmounted, so no media loads until the presenter plays it.
 * - `open`: the stage covers the slide canvas edge-to-edge and plays the video.
 * - `closing`: playback pauses immediately while the stage fades out; unmounts on transition end.
 */
type StageState = "idle" | "open" | "closing";

/** The props a slide gives `<Video>`. */
export type VideoProps = {
  /** The video URL, typically imported from a file inside the deck so the build bundles it. */
  readonly src: string;
  /** Accessible name for the play button and player, also shown as a quiet caption when present. */
  readonly title?: string;
  /** Optional poster image shown behind the play button before playback starts. */
  readonly poster?: string;
  /** Optional WebVTT caption track URL. */
  readonly captions?: string;
  /** Loop playback instead of returning to the play button when the video finishes. */
  readonly loop?: boolean;
  /** Start muted. Clicking Play is a user gesture, so audio plays without muting by default. */
  readonly muted?: boolean;
};

/**
 * A quiet Fuse play button on the slide that lazily loads the video and transitions it edge-to-edge
 * on the canvas when pressed. Press Escape, click close, or let a non-looping video finish to fade
 * back to the slide.
 */
export function Video({ src, title, poster, captions, loop = false, muted = false }: VideoProps) {
  const [stage, setStage] = useState<StageState>("idle");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const stageElement = useRef<HTMLDivElement | null>(null);
  const player = useRef<HTMLVideoElement | null>(null);

  const open = useCallback(() => {
    setStage("open");
  }, []);

  const close = useCallback(() => {
    const video = player.current;
    if (video !== null) {
      video.pause();
    }
    const element = stageElement.current;
    const style = element === null ? null : getComputedStyle(element);
    // An exit transition only fires `transitionend` when opacity actually moves away from a
    // non-zero value; if closed before the first painted frame or with 0s duration, settle now.
    const hasExitTransition =
      style !== null &&
      Number.parseFloat(style.transitionDuration) > 0 &&
      Number.parseFloat(style.opacity) > 0;
    setStage(hasExitTransition ? "closing" : "idle");
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (stage !== "open") {
      return;
    }
    const video = player.current;
    if (video !== null) {
      video.focus();
      void video.play().catch(() => undefined);
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      // When focus sits on the backdrop rather than the <video> or close button, Space still
      // toggles playback instead of scrolling or leaking to the deck.
      if (
        event.key === " " &&
        event.target instanceof HTMLElement &&
        event.target.closest("video, button") === null
      ) {
        event.preventDefault();
        const active = player.current;
        if (active !== null) {
          if (active.paused) {
            void active.play().catch(() => undefined);
          } else {
            active.pause();
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [stage, close]);

  const handleStageTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && event.propertyName === "opacity" && stage === "closing") {
      setStage("idle");
    }
  };

  const handleEnded = () => {
    if (!loop) {
      close();
    }
  };

  const label = title !== undefined && title.trim() !== "" ? title.trim() : undefined;
  const playLabel = label === undefined ? "Play video" : `Play ${label}`;
  const isOpen = stage === "open";
  const isMounted = stage !== "idle";

  const variant = poster === undefined ? "outline" : "secondary";
  const overlayClass = poster === undefined ? "" : " deck-video-play-overlay";
  const playButton =
    label === undefined ? (
      <Button
        ref={trigger}
        type="button"
        variant={variant}
        size="icon-lg"
        className={`deck-video-play${overlayClass}`}
        aria-label={playLabel}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={open}>
        <Play weight="fill" className="size-auto deck-video-play-icon" />
      </Button>
    ) : (
      <Button
        ref={trigger}
        type="button"
        variant={variant}
        size="lg"
        className={`deck-video-play deck-video-play-labeled${overlayClass}`}
        aria-label={playLabel}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={open}>
        <Play weight="fill" data-icon="inline-start" className="size-auto deck-video-play-icon" />
        <span>{label}</span>
      </Button>
    );

  return (
    <div className="deck-video" data-has-poster={poster === undefined ? undefined : ""}>
      {poster === undefined ? (
        playButton
      ) : (
        <div className="deck-video-poster-frame">
          <img src={poster} alt="" className="deck-video-poster" />
          {playButton}
        </div>
      )}

      {createPortal(
        <div
          ref={stageElement}
          className="deck-video-stage"
          role="dialog"
          aria-modal="true"
          aria-label={label ?? "Video"}
          aria-hidden={!isOpen}
          data-state={stage}
          data-deck-overlay={isOpen ? "open" : undefined}
          inert={!isOpen}
          onTransitionEnd={handleStageTransitionEnd}>
          {isMounted ? (
            <>
              {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- captions are optional author input and rendered when `captions` is passed */}
              <video
                ref={player}
                className="deck-video-player"
                src={src}
                poster={poster}
                loop={loop}
                muted={muted}
                controls
                playsInline
                autoPlay
                onEnded={handleEnded}>
                {captions === undefined ? null : <track kind="captions" src={captions} default />}
              </video>
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                className="deck-video-close"
                aria-label="Close video"
                onClick={close}>
                <X className="size-auto deck-video-close-icon" />
              </Button>
            </>
          ) : null}
        </div>,
        document.body
      )}
    </div>
  );
}
