#!/bin/sh
set -e

: "${SEAWEEDFS_ACCESS_KEY:?SEAWEEDFS_ACCESS_KEY is required}"
: "${SEAWEEDFS_SECRET_KEY:?SEAWEEDFS_SECRET_KEY is required}"
BUCKET="${SEAWEEDFS_BUCKET:-alba-media}"

mkdir -p /etc/seaweedfs
cat > /etc/seaweedfs/s3-config.json <<EOF
{
  "identities": [
    {
      "name": "admin",
      "credentials": [{"accessKey": "${SEAWEEDFS_ACCESS_KEY}", "secretKey": "${SEAWEEDFS_SECRET_KEY}"}],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    },
    {
      "name": "anonymous",
      "actions": ["Read"],
      "resources": ["bucket:${BUCKET}", "bucket:${BUCKET}/*"]
    }
  ]
}
EOF

# One process handles master+volume+filer+s3 - simplest topology for a
# single-server deployment, matching how parser-worker/piper-tts each run as
# one self-contained container rather than a multi-service stack.
weed server -dir=/data -master.volumeSizeLimitMB=1024 -ip.bind=0.0.0.0 \
    -s3 -s3.config=/etc/seaweedfs/s3-config.json -s3.port=8333 \
    -webdav=false &
SERVER_PID=$!

# Create the bucket once the S3 API is actually accepting connections - weed
# server doesn't create buckets from the identity config alone, that only
# grants permissions on a bucket once it exists.
(
    until nc -z localhost 8333 2>/dev/null; do sleep 1; done
    sleep 1
    weed shell -master=localhost:9333 <<CMDS
s3.bucket.create -name ${BUCKET}
CMDS
    echo "seaweedfs entrypoint: bucket '${BUCKET}' ready"
) &

wait $SERVER_PID
