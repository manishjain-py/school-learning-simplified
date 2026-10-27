resource "aws_cognito_user_pool" "users" {

  name                     = "${local.name}-users"
  user_pool_tier           = "LITE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  username_configuration {
    case_sensitive = false
  }
  account_recovery_setting {

    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }

  }
  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }
  password_policy {

    minimum_length                   = 10
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 1

  }
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }
  verification_message_template {

    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Verify your School Learning Simplified email"
    email_message        = "Your School Learning Simplified verification code is {####}."

  }
  deletion_protection = "ACTIVE"

}
resource "aws_cognito_user_pool_client" "web" {

  name                          = "school-learning-web"
  user_pool_id                  = aws_cognito_user_pool.users.id
  generate_secret               = false
  explicit_auth_flows           = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  access_token_validity         = 1
  id_token_validity             = 1
  refresh_token_validity        = 7
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
  read_attributes  = ["email", "email_verified"]
  write_attributes = ["email"]

}
