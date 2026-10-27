resource "aws_route53_zone" "app" {

  name    = var.domain
  comment = "School Learning Simplified independent hackathon zone"

}
resource "aws_acm_certificate" "web" {

  provider                  = aws.certificate
  domain_name               = var.domain
  subject_alternative_names = ["www.${var.domain}"]
  validation_method         = "DNS"
  lifecycle {
    create_before_destroy = true
  }

}
resource "aws_route53_record" "certificate" {

  for_each = {

    for d in aws_acm_certificate.web.domain_validation_options : d.domain_name => {

      name   = d.resource_record_name
      record = d.resource_record_value
      type   = d.resource_record_type

    }

  }
  zone_id = aws_route53_zone.app.zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 300
  records = [each.value.record]

}
resource "aws_acm_certificate_validation" "web" {
  count = var.custom_domain_enabled ? 1 : 0

  provider                = aws.certificate
  certificate_arn         = aws_acm_certificate.web.arn
  validation_record_fqdns = [for r in aws_route53_record.certificate : r.fqdn]
  timeouts {
    create = "45m"
  }

}
resource "aws_cloudfront_origin_access_control" "s3" {

  name                              = "${local.name}-private-s3"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"

}
resource "aws_cloudfront_function" "spa" {

  name    = "${local.name}-spa"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var request = event.request;
      if (request.uri.indexOf('.') === -1) request.uri = '/index.html';
      return request;
    }
  JS

}
data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}
data "aws_cloudfront_origin_request_policy" "api" {
  name = "Managed-AllViewerExceptHostHeader"
}
resource "aws_cloudfront_response_headers_policy" "web" {

  name = "${local.name}-browser-security"
  security_headers_config {

    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      override                   = true
    }
    content_security_policy {

      content_security_policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' https://cognito-idp.${var.region}.amazonaws.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      override                = true

    }

  }

}
resource "aws_cloudfront_distribution" "web" {

  enabled             = true
  is_ipv6_enabled     = true
  comment             = "School Learning Simplified web and API"
  aliases             = var.custom_domain_enabled ? [var.domain, "www.${var.domain}"] : []
  default_root_object = "index.html"
  price_class         = "PriceClass_200"
  origin {

    origin_id                = "web"
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id

  }
  origin {

    origin_id                = "content"
    domain_name              = aws_s3_bucket.content.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id

  }
  origin {

    origin_id   = "api"
    domain_name = replace(aws_apigatewayv2_api.app.api_endpoint, "https://", "")
    custom_origin_config {

      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]

    }

  }
  default_cache_behavior {

    target_origin_id           = "web"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.web.id
    compress                   = true
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa.arn
    }

  }
  ordered_cache_behavior {

    path_pattern               = "/api/*"
    target_origin_id           = "api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.api.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.web.id
    compress                   = true

  }
  ordered_cache_behavior {

    path_pattern               = "/content/*"
    target_origin_id           = "content"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.web.id
    compress                   = true

  }
  ordered_cache_behavior {

    path_pattern               = "/media/*"
    target_origin_id           = "content"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.web.id
    compress                   = true

  }
  ordered_cache_behavior {

    path_pattern               = "/assets/*"
    target_origin_id           = "web"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.web.id
    compress                   = true

  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {

    acm_certificate_arn            = var.custom_domain_enabled ? aws_acm_certificate_validation.web[0].certificate_arn : null
    cloudfront_default_certificate = !var.custom_domain_enabled
    ssl_support_method             = var.custom_domain_enabled ? "sni-only" : null
    minimum_protocol_version       = var.custom_domain_enabled ? "TLSv1.2_2021" : "TLSv1"

  }

}
resource "aws_s3_bucket_policy" "web" {

  bucket = aws_s3_bucket.web.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Principal = {
          Service = "cloudfront.amazonaws.com"
          }, Action = "s3:GetObject", Resource = "${aws_s3_bucket.web.arn}/*", Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.web.arn
          }
        }
      },
      {
        Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.web.arn, "${aws_s3_bucket.web.arn}/*"], Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })

}
resource "aws_s3_bucket_policy" "content" {

  bucket = aws_s3_bucket.content.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Principal = {
          Service = "cloudfront.amazonaws.com"
          }, Action = "s3:GetObject", Resource = ["${aws_s3_bucket.content.arn}/content/*", "${aws_s3_bucket.content.arn}/media/*"], Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.web.arn
          }
        }
      },
      {
        Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.content.arn, "${aws_s3_bucket.content.arn}/*"], Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })

}
resource "aws_route53_record" "site" {

  for_each = {
    apex_a = {
      name = var.domain, type = "A"
      }, apex_aaaa = {
      name = var.domain, type = "AAAA"
      }, www_a = {
      name = "www.${var.domain}", type = "A"
      }, www_aaaa = {
      name = "www.${var.domain}", type = "AAAA"
    }
  }
  zone_id = aws_route53_zone.app.zone_id
  name    = each.value.name
  type    = each.value.type
  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }

}
