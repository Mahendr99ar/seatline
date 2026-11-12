# Hosting Seatline and judgebox for free

Both projects run on one Oracle Cloud Always Free VM, behind one Caddy server
that handles HTTPS for two subdomains:

```
fly-<you>.duckdns.org    ─┐                 ┌─> 127.0.0.1:8080  Seatline (gateway, 3 services, Postgres, RabbitMQ)
                          ├─> Caddy :443 ───┤
judge-<you>.duckdns.org  ─┘                 └─> 127.0.0.1:8000  judgebox (API, 2 workers, Postgres, Redis)
```

Cost: nothing, if the VM stays inside the free limits. A domain of your own is
optional; DuckDNS subdomains are free.

## 1. Oracle Cloud account

- Sign up at cloud.oracle.com. A credit or debit card is needed to verify you;
  Always Free resources are not charged. Some Indian debit cards are refused at
  this step; try another card if that happens.
- Pick your **home region** carefully (Mumbai or Hyderabad are closest). Always
  Free compute only exists in the home region and it cannot be changed later.

## 2. Create the VM

Compute, Instances, Create instance:

- Image: **Canonical Ubuntu 24.04**
- Shape: **VM.Standard.A1.Flex** (Ampere, ARM), **2 OCPU, 12 GB memory**. This
  is the whole Always Free allowance since Oracle halved it in 2026. Oracle
  terminates instances that go over it, so do not create a second A1 instance.
- Boot volume: 100 GB is fine (200 GB total is free).
- Upload your SSH public key (`~/.ssh/id_ed25519.pub`).

"Out of host capacity" means the region has no free ARM machines right now.
Try another availability domain, or try again in a few hours.

Note the public IP once it is running, then:

```bash
ssh ubuntu@<public-ip>
```

## 3. Open ports 80 and 443

Two firewalls are in the way.

**Oracle security list:** Networking, Virtual cloud networks, your VCN, the
subnet, Default security list, Add ingress rules: source `0.0.0.0/0`, TCP,
destination ports `80,443`.

**Ubuntu on Oracle ships iptables rules that reject everything but SSH:**

```bash
sudo iptables -I INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
sudo netfilter-persistent save
```

Do not open 5432, 5672, 6379, 8000 or 8080. Everything except Caddy listens on
localhost or inside Docker only.

## 4. Free subdomains

At duckdns.org, sign in and create two subdomains, for example
`fly-mahendra` and `judge-mahendra`. Set both to the VM's public IP.

## 5. Install Docker and a swap file

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker ubuntu && newgrp docker

# Builds use more memory than running does. 4 GB of swap avoids surprises.
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 6. Seatline

```bash
git clone https://github.com/<you>/seatline.git && cd seatline
cp .env.example .env
for k in JWT_SECRET INTERNAL_TOKEN POSTGRES_PASSWORD RABBITMQ_PASSWORD; do
  sed -i "s/^$k=.*/$k=$(openssl rand -hex 32)/" .env
done

docker compose up -d --build
docker compose run --rm gateway node dist/cli.js seed 30
docker compose run --rm gateway node dist/cli.js create-admin you@example.com "Your Name"
curl -s localhost:8080/healthz      # {"ok":true}
```

The seed creates sample flights for the next 30 days. Run it again every few
weeks (or from cron) so the site always has future flights; it skips flights
that already exist.

## 7. judgebox

Follow `deploy/oracle-vm.md` in that repo, with one change: in its
`docker-compose.yml`, bind the API to localhost so only Caddy can reach it:

```yaml
    ports:
      - "127.0.0.1:8000:8000"
```

## 8. Caddy for HTTPS

Create `~/Caddyfile`:

```
fly-mahendra.duckdns.org {
    reverse_proxy 127.0.0.1:8080
}

judge-mahendra.duckdns.org {
    reverse_proxy 127.0.0.1:8000
}
```

Run it:

```bash
docker run -d --name caddy --restart unless-stopped --network host \
  -v ~/Caddyfile:/etc/caddy/Caddyfile:ro -v caddy_data:/data caddy:2
```

Caddy gets Let's Encrypt certificates on its own. After a minute both sites
should open over https. If not, `docker logs caddy` usually says which port is
still blocked.

## 9. Keep it healthy

**Uptime:** add two free monitors on uptimerobot.com:
`https://fly-mahendra.duckdns.org/healthz` and
`https://judge-mahendra.duckdns.org/api/health`. Regular traffic also keeps
Oracle from treating the VM as idle.

**Backups:** a nightly dump of the Seatline databases, keeping a week:

```bash
mkdir -p ~/backups
crontab -e
# add:
30 2 * * * cd ~/seatline && for db in users flights bookings notifications; do docker compose exec -T db pg_dump -U seatline seatline_$db | gzip > ~/backups/seatline_${db}_$(date +\%a).sql.gz; done
```

**Updates:**

```bash
cd ~/seatline && git pull && docker compose up -d --build
```

Schema changes run on startup, so there is no separate migrate step.

**Logs:** `docker compose logs -f bookings` (or any service name).

## Memory budget

Seatline's compose file caps its containers at 1.6 GB in total (Postgres
384 MB, RabbitMQ 512 MB, each Node service 192 MB). Measured while idle after
a load test: gateway 117 MB, bookings 119 MB, flights 80 MB, notifications
83 MB, RabbitMQ 127 MB. judgebox's workers are bounded per submission by its
own cgroup limits. 12 GB leaves plenty of room for both; CPU is the tighter
resource, which is why judgebox runs two workers and not more.

## If you cannot get an Oracle VM

judgebox needs a VM, because its workers create namespaces and cgroups, which
platforms like Render or Railway do not allow. A small paid VPS works with
exactly the steps above. Seatline alone can also run on platforms with free
tiers for web services, managed Postgres and hosted RabbitMQ, but free web
services usually sleep when idle, so the first request after a pause is slow.
