package com.pocketpalai.speech

data class SpeechQueueItem(
  val text: String,
  val options: Map<String, Any>,
  val utteranceId: String,
  var position: Int = 0,
  var offset: Int = 0,
  var status: SpeechStatus = SpeechStatus.PENDING
)

enum class SpeechStatus {
  PENDING,
  SPEAKING,
  PAUSED,
  COMPLETED,
  ERROR
}