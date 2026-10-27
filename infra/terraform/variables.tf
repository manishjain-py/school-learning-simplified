variable "region" {

  type    = string
  default = "us-east-2"

}
variable "domain" {

  type    = string
  default = "schoollearningsimplified.com"

}
variable "github_repository" {

  type    = string
  default = "manishjain-py/school-learning-simplified"

}

variable "custom_domain_enabled" {
  description = "Enable only after registrar delegation and ACM validation can complete."
  type        = bool
  default     = false
}

variable "content_release" {
  description = "Selected content release; empty keeps the verified foundation."
  type        = string
  default     = ""
  validation {
    condition     = contains(["", "m2"], var.content_release)
    error_message = "Use an empty release for the foundation or m2 after full-content verification."
  }
}

variable "school_ai_enabled" {
  description = "Opt-in only after bounded inference and publication checks; disabled preserves school logs without AI calls."
  type        = bool
  default     = false
}

variable "github_oidc_subject" {
  description = "Exact current main-branch subject from the repository OIDC configuration; set privately."
  type        = string
  sensitive   = true
  validation {
    condition     = endswith(var.github_oidc_subject, ":ref:refs/heads/main") && startswith(var.github_oidc_subject, "repo:")
    error_message = "The deployment subject must identify one repository main branch."
  }
}
