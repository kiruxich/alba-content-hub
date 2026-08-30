FROM chrislusf/seaweedfs:latest

RUN apk add --no-cache netcat-openbsd

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME /data
EXPOSE 8333 9333

ENTRYPOINT ["/entrypoint.sh"]
