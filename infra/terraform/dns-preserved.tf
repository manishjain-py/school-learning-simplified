# Existing non-website DNS records observed before moving registrar delegation.
# Apex/www parking are intentionally replaced by the new site's aliases.
resource "aws_route53_record" "domainconnect" {
  zone_id = aws_route53_zone.app.zone_id
  name    = "_domainconnect.${var.domain}"
  type    = "CNAME"
  ttl     = 3600
  records = ["_domainconnect.gd.domaincontrol.com."]
}
resource "aws_route53_record" "dmarc" {
  zone_id = aws_route53_zone.app.zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 3600
  records = ["v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;"]
}
