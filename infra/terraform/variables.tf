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
