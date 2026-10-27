resource "aws_dynamodb_table" "application" {

  name         = "${local.name}-data"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"
  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  on_demand_throughput {

    max_read_request_units  = 50
    max_write_request_units = 50

  }
  point_in_time_recovery {
    enabled = true
  }
  deletion_protection_enabled = true

}
resource "aws_s3_bucket" "web" {
  bucket = "${local.name}-web-${random_id.buckets.hex}"
}
resource "aws_s3_bucket" "content" {
  bucket = "${local.name}-content-${random_id.buckets.hex}"
}
locals {
  buckets = {
    web = aws_s3_bucket.web.id, content = aws_s3_bucket.content.id
  }
}
resource "aws_s3_bucket_public_access_block" "app" {

  for_each                = local.buckets
  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

}
resource "aws_s3_bucket_ownership_controls" "app" {

  for_each = local.buckets
  bucket   = each.value
  rule {
    object_ownership = "BucketOwnerEnforced"
  }

}
resource "aws_s3_bucket_server_side_encryption_configuration" "app" {

  for_each = local.buckets
  bucket   = each.value
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }

}
resource "aws_s3_bucket_versioning" "content" {

  bucket = aws_s3_bucket.content.id
  versioning_configuration {
    status = "Enabled"
  }

}
