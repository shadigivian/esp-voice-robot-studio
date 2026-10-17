/** Normalize only measurements actually emitted by the provider. Each response
 * contributes its own delta; session totals are maintained by the service. */
export function realtimeUsageEvent(event: any) {
  if (event.type !== "response.done" || !event.response?.usage) return null;
  const current = event.response.usage;
  const values = {
    input_tokens: current.input_tokens,
    output_tokens: current.output_tokens,
    input_audio_tokens: current.input_token_details?.audio_tokens,
    output_audio_tokens: current.output_token_details?.audio_tokens,
    input_text_tokens: current.input_token_details?.text_tokens,
    output_text_tokens: current.output_token_details?.text_tokens,
  };
  const usage = Object.fromEntries(
    Object.entries(values).filter(
      ([, value]) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    ),
  );
  if (!Object.keys(usage).length) return null;
  return {
    type: "usage",
    usage,
    eventId:
      typeof event.response.id === "string"
        ? `response:${event.response.id}`
        : typeof event.event_id === "string"
          ? event.event_id
          : undefined,
  };
}
export function realtimeTranscriptEvent(event: any) {
  if (
    ![
      "conversation.item.input_audio_transcription.completed",
      "response.output_audio_transcript.done",
    ].includes(event.type) ||
    typeof event.transcript !== "string"
  )
    return null;
  return {
    type: "message",
    role: event.type.startsWith("conversation.") ? "user" : "assistant",
    text: event.transcript,
  };
}
