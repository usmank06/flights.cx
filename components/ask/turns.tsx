"use client";

import type { ReactNode } from "react";
import { cx } from "@/components/ui/primitives";

/** The two sides of the conversation: a question, and an answer bubble that reopens its question when pressed. */

/** The question being asked, with an optional line of help. `hero` styles the first question on the landing. */
export function Ask({ id, title, sub, hero = false }: { id: string; title: string; sub?: ReactNode; hero?: boolean }) {
  return (
    <div className={cx("flex flex-col", hero ? "intro gap-3" : "msg-in gap-1.5")}>
      <h1
        id={id}
        className={cx(
          "display font-semibold text-balance text-ink",
          hero ? "text-[38px] leading-[1.02] sm:text-[54px] lg:text-[62px]" : "text-[26px] leading-[1.12] sm:text-[32px]"
        )}
      >
        {title}
      </h1>
      {sub && <p className={cx("leading-relaxed text-ink-muted", hero ? "text-[16px] sm:text-[18px]" : "text-[15.5px]")}>{sub}</p>}
    </div>
  );
}

/** A question already answered, and the answer. */
export function Answered({
  question,
  answer,
  note,
  onEdit,
}: {
  question: string;
  answer: ReactNode;
  /** How the search will use the answer, e.g. "ORD and Midway". */
  note?: string;
  onEdit?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="fade text-[15px] font-medium text-ink-muted">{question}</p>
      <div className="flex flex-col items-end gap-1.5 pl-10">
        <button
          type="button"
          onClick={onEdit}
          disabled={!onEdit}
          aria-label={`${question} ${typeof answer === "string" ? answer : ""}. Change this answer`}
          className="bubble-in btn-primary press max-w-full rounded-[22px] rounded-br-[7px] px-4 py-2.5 text-left text-[16px] leading-snug font-medium break-words whitespace-pre-line disabled:opacity-100 pointer-coarse:min-h-11"
        >
          {answer}
        </button>
        {note && (
          <p className="fade pr-1 text-right text-[12.5px] text-ink-muted" style={{ animationDelay: "220ms" }}>
            {note}
          </p>
        )}
      </div>
    </div>
  );
}
