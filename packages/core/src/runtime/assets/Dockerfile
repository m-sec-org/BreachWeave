FROM --platform=linux/amd64 kalilinux/kali-rolling AS base

ARG KALI_MIRROR=http://mirrors.ustc.edu.cn/kali
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALL_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG all_proxy
ARG no_proxy

ENV DEBIAN_FRONTEND=noninteractive
ENV AGENT_BROWSER_HEADLESS=1
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

# COPY ./binary/tch-headless/tch-headless-linux-amd64 .

# RUN mv tch-headless-linux-amd64 /usr/local/bin/tch-headless

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    printf 'deb %s kali-rolling main contrib non-free non-free-firmware\n' "$KALI_MIRROR" > /etc/apt/sources.list; \
    printf 'deb-src %s kali-rolling main contrib non-free non-free-firmware\n' "$KALI_MIRROR" >> /etc/apt/sources.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        git \
        7zip \
        7zip-rar \
        unzip \
        jq \
        file \
        xxd \
        binutils \
        openssh-client \
        openssh-server \
        iproute2 \
        iputils-ping \
        xdg-utils \
        \
        default-jre-headless \
        default-mysql-client \
        python3 \
        python-is-python3 \
        python3-pip \
        python3-venv \
        sqlite3 \
        pipx \
        \
        chromium \
        chromium-sandbox \
        fonts-liberation \
        fonts-noto-color-emoji \
        fonts-noto-cjk \
        \
        fcrackzip \
        hashcat \
        hydra \
        john \
        nmap \
        gobuster \
        whatweb \
        rarcrack \
        sslscan \
        sqlmap \
        proxychains4 \
        seclists \
        wfuzz \
        dirsearch \
        redis-tools \
        responder \
        enum4linux; \
    rm -rf /var/lib/apt/lists/*

RUN python -m pip install --break-system-packages --ignore-installed --no-cache-dir \
        "cryptography>=36.0.1" \
        httpx \
        "idna>=3.3" \
        "pyOpenSSL>=22.0.0" \
        "requests>=2.27.0" \
        websocket-client \
        dnspython \
        pwntools \
        pycryptodome \
        pypsrp \
        scapy \
        beautifulsoup4 \
        "lxml>=4.9.2" \
        pyyaml \
        jsbeautifier \
        python-socketio \
        colorama \
        tqdm \
        rich \
        flask \
        jinja2 \
        flask-unsign \
        pyjwt \
        sympy \
        z3-solver \
        impacket \
        certipy-ad \
        bloodhound \
        ldapdomaindump \
        requests_ntlm2 \
        tldextract \
        urllib3 \
        coercer \
        dsinternals

ENV PATH="/root/.local/bin:$PATH"
RUN pipx install pypykatz \
    && pipx install coercer \
    && pipx install "git+https://github.com/Pennyw0rth/NetExec" \
    && pipx install adidnsdump \
    && pipx install bloodyAD

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*


RUN apt-get update \
    && (apt-get install -y --no-install-recommends ncat || apt-get install -y --no-install-recommends netcat-openbsd || echo "No netcat variant available") \
    && rm -rf /var/lib/apt/lists/*

FROM base AS agent-browser-builder

ARG AGENT_BROWSER_VERSION=latest

RUN npm install -g --prefix /opt/agent-browser "agent-browser@${AGENT_BROWSER_VERSION}" \
    && /opt/agent-browser/bin/agent-browser --version

RUN wget "https://github.com/ffuf/ffuf/releases/download/v2.1.0/ffuf_2.1.0_linux_amd64.tar.gz" \
    && tar -zxvf ffuf_2.1.0_linux_amd64.tar.gz \
    && cp ffuf /opt/ffuf

RUN wget "https://github.com/ropnop/kerbrute/releases/download/v1.0.3/kerbrute_linux_amd64" \
    && cp kerbrute_linux_amd64 /opt/kerbrute

RUN wget "https://github.com/shadow1ng/fscan/releases/download/1.8.4/fscan" \
    && cp fscan /opt/fscan

RUN wget "https://github.com/projectdiscovery/nuclei/releases/download/v3.7.1/nuclei_3.7.1_linux_amd64.zip" \
    && unzip nuclei_3.7.1_linux_amd64.zip -d /tmp/nuclei \
    && cp /tmp/nuclei/nuclei /opt/nuclei \
    && rm -rf nuclei_3.7.1_linux_amd64.zip /tmp/nuclei

FROM base

COPY --from=agent-browser-builder /opt/agent-browser /opt/agent-browser
COPY --from=agent-browser-builder /opt/ffuf /opt/ffuf
COPY --from=agent-browser-builder /opt/kerbrute /opt/kerbrute
COPY --from=agent-browser-builder /opt/fscan /opt/fscan
COPY --from=agent-browser-builder /opt/nuclei /opt/nuclei

RUN ln -sf /opt/agent-browser/bin/agent-browser /usr/local/bin/agent-browser \
    && agent-browser --version \
    && agent-browser open about:blank \
    && agent-browser get title \
    && agent-browser close
RUN chmod +x /opt/ffuf && ln -sf /opt/ffuf /usr/local/bin/ffuf
RUN chmod +x /opt/kerbrute && ln -sf /opt/kerbrute /usr/local/bin/kerbrute
RUN chmod +x /opt/fscan && ln -sf /opt/fscan /usr/local/bin/fscan
RUN chmod +x /opt/nuclei && ln -sf /opt/nuclei /usr/local/bin/nuclei

# nuclei-templates
RUN git clone --depth 1 https://github.com/projectdiscovery/nuclei-templates.git /root/nuclei-templates

# AD 攻击工具
RUN git clone --depth 1 https://github.com/Ridter/noPac.git /opt/noPac
RUN git clone --depth 1 https://github.com/dirkjanm/CVE-2020-1472.git /opt/zerologon
RUN git clone --depth 1 https://github.com/ly4k/PetitPotam.git /opt/petitpotam
RUN git clone --depth 1 https://github.com/topotam/PetitPotam.git /opt/PetitPotam
RUN git clone --depth 1 https://github.com/dirkjanm/krbrelayx.git /opt/krbrelayx
RUN git clone --depth 1 https://github.com/dirkjanm/PKINITtools.git /opt/PKINITtools
RUN git clone --depth 1 https://github.com/GhostPack/Rubeus.git /opt/Rubeus

# rockyou（若未安装 wordlists，此命令会被忽略）
RUN gunzip -f /usr/share/wordlists/rockyou.txt.gz 2>/dev/null || true

# 如无需自定义安装，建议删除以下两段（可能重新拉入大量工具）
# COPY build/setup/ /tmp/setup/
# RUN chmod +x /tmp/setup/*.sh
# RUN for script in /tmp/setup/*.sh; do \
#         echo "Executing: $script"; \
#         bash "$script" || exit 1; \
#     done

RUN rm -rf /tmp/setup /tmp/*.zip /tmp/*.deb /var/lib/apt/lists/*

RUN touch /root/THIS_IS_DOCKER_CONTAINER_NOT_TARGET_MACHINE.txt

RUN git clone https://github.com/ticarpi/jwt_tool /opt/jwt_tool \
    && cd /opt/jwt_tool \
    && pip install --break-system-packages  -r requirements.txt \
    && python3 jwt_tool.py -h
