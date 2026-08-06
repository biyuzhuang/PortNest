import { For, Show, createEffect, createSignal } from "solid-js";
import { feedback } from "../stores/feedbackStore";

export const FeedbackHost = () => {
  const [value, setValue] = createSignal("");

  createEffect(() => {
    setValue(feedback.dialog()?.initialValue || "");
  });

  const accept = () => {
    const current = feedback.dialog();
    if (!current) return;
    feedback.resolveDialog(current.kind === "prompt" ? value() : true);
  };

  return <>
    <div class="toast-viewport" aria-live="polite">
      <For each={feedback.toasts()}>{toast =>
        <button class={`app-toast ${toast.kind}`} onClick={() => feedback.dismissToast(toast.id)}>
          <span>{toast.kind === "success" ? "✓" : toast.kind === "error" ? "!" : "i"}</span>
          {toast.message}
        </button>
      }</For>
    </div>
    <Show when={feedback.dialog()}>{current =>
      <div class="modal-overlay feedback-overlay" onClick={() => feedback.resolveDialog(current().kind === "confirm" ? false : null)}>
        <section class="feedback-dialog" role="dialog" aria-modal="true" onClick={event => event.stopPropagation()}>
          <h3>{current().title}</h3>
          <p>{current().message}</p>
          <Show when={current().kind === "prompt"}>
            <input autofocus value={value()} onInput={event => setValue(event.currentTarget.value)} onKeyDown={event => {
              if (event.key === "Enter") accept();
              if (event.key === "Escape") feedback.resolveDialog(null);
            }} />
          </Show>
          <footer>
            <button class="btn-cancel" onClick={() => feedback.resolveDialog(current().kind === "confirm" ? false : null)}>取消</button>
            <button class="btn-save" onClick={accept}>确定</button>
          </footer>
        </section>
      </div>
    }</Show>
  </>;
};
