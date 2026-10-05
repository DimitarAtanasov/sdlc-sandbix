# Example spec: NeedIt Scripted REST API

This file exists only to demonstrate the orchestration engine's H-factor
spec-similarity check. Replace it with your real specs, or add more `.md`
files under `specs/` or `docs/specs/`.

## Scope

Defines the contract for the NeedIt scripted REST API endpoints that the
.NET integration layer and Kafka producers call: request/response payload
shape, field validation rules, and error codes for `u_request_type`,
`u_what_needed`, and `u_requested_for` on the `x_58872_needit_needit` table.

## Out of scope

Kafka topic/partition configuration, .NET client retry policy, ServiceNow
ACL/role changes.
