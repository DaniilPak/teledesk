variable "name" {
  description = "Resource name prefix"
  type        = string
  default     = "teledesk"
}

variable "region" {
  description = "AWS region"
  type        = string
  default     = "ap-southeast-2"
}

variable "telegram_bot_token" {
  description = "Bot token from @BotFather"
  type        = string
  sensitive   = true
}

variable "telegram_bot_username" {
  description = "Bot username without @, e.g. MySupportBot"
  type        = string
}

variable "register_telegram_webhook" {
  description = "Point the bot's webhook at this deployment (replaces any existing webhook)"
  type        = bool
  default     = true
}

variable "api_rate_limit" {
  description = "Steady-state API requests per second"
  type        = number
  default     = 50
}

variable "api_burst_limit" {
  description = "API burst limit"
  type        = number
  default     = 100
}
