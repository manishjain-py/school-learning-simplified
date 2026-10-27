terraform {

  required_version = ">= 1.5.0"
  backend "s3" {

  }
  required_providers {

    aws = {
      source = "hashicorp/aws", version = "~> 6.0"
    }
    archive = {
      source = "hashicorp/archive", version = "~> 2.0"
    }
    random = {
      source = "hashicorp/random", version = "~> 3.0"
    }

  }

}
provider "aws" {

  region = var.region
  default_tags {
    tags = local.tags
  }

}
provider "aws" {

  alias  = "certificate"
  region = "us-east-1"
  default_tags {
    tags = local.tags
  }

}
locals {

  name = "sls-hackathon-2026"
  tags = {
    Project = "schoollearningsimplified", Environment = "hackathon", ManagedBy = "terraform"
  }

}
data "aws_caller_identity" "current" {

}
data "aws_partition" "current" {

}
resource "random_id" "buckets" {
  byte_length = 4
}
