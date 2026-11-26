import type { Company } from "../../src/server/addresses";

export function event(type: string, data: object) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export function stream(
  chunks: (string | Uint8Array)[],
  headers: ResponseInit["headers"],
  delayMs: number,
  status = 200,
) {
  const encoder = new TextEncoder();
  let index = 0;
  let cancelled = false;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        if (index === chunks.length) {
          controller.close();
          return;
        }
        if (index) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (!cancelled) {
          const chunk = chunks[index++]!;
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        }
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status, headers },
  );
}

export function codexCommand(model: string, command: string) {
  const response = { id: "resp_fake_command", object: "response", created_at: 1, model };
  const item = {
    id: "fc_fake",
    type: "function_call",
    call_id: "call_fake",
    name: "exec_command",
    arguments: JSON.stringify({ cmd: command, login: false }),
    status: "completed",
  };
  return [
    event("response.created", { response: { ...response, status: "in_progress", output: [] } }),
    event("response.output_item.done", { output_index: 0, item }),
    event("response.completed", {
      response: { ...response, status: "completed", output: [item] },
    }),
  ];
}

export function turn(company: Company, model: string, partial: boolean) {
  const text = ["Fake ", "reply."];
  if (company === "anthropic") {
    const usage = { input_tokens: 8, output_tokens: 0 };
    return [
      event("message_start", {
        message: {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      }),
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      ...text
        .slice(0, partial ? 1 : 2)
        .map((delta) =>
          event("content_block_delta", { index: 0, delta: { type: "text_delta", text: delta } }),
        ),
      ...(partial
        ? [event("error", { error: { type: "rate_limit_error", message: "Fake limit" } })]
        : [
            event("content_block_stop", { index: 0 }),
            event("message_delta", {
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 2 },
            }),
            event("message_stop", {}),
          ]),
    ];
  }
  const response = { id: "resp_fake", object: "response", created_at: 1, model };
  const item = { id: "msg_fake", type: "message", role: "assistant", status: "in_progress", content: [] };
  const coordinates = { item_id: item.id, output_index: 0, content_index: 0 };
  const part = { type: "output_text", text: text.join(""), annotations: [] };
  return [
    event("response.created", { response: { ...response, status: "in_progress", output: [] } }),
    event("response.output_item.added", { output_index: 0, item }),
    event("response.content_part.added", { ...coordinates, part: { ...part, text: "" } }),
    ...text
      .slice(0, partial ? 1 : 2)
      .map((delta) => event("response.output_text.delta", { ...coordinates, delta })),
    ...(partial
      ? [
          event("response.failed", {
            response: {
              ...response,
              status: "failed",
              output: [],
              error: { code: "usage_limit_reached", message: "Fake limit" },
            },
          }),
        ]
      : [
          event("response.output_text.done", { ...coordinates, text: part.text }),
          event("response.content_part.done", { ...coordinates, part }),
          event("response.output_item.done", {
            output_index: 0,
            item: { ...item, status: "completed", content: [part] },
          }),
          event("response.completed", {
            response: {
              ...response,
              status: "completed",
              output: [{ ...item, status: "completed", content: [part] }],
              usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
            },
          }),
        ]),
  ];
}
