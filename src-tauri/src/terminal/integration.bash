# Keep login/user initialization and existing prompt hooks in this process.
if [[ -f /etc/profile ]]; then source /etc/profile; fi
if [[ -f ~/.bash_profile ]]; then source ~/.bash_profile
elif [[ -f ~/.bash_login ]]; then source ~/.bash_login
elif [[ -f ~/.profile ]]; then source ~/.profile
fi
if [[ -f ~/.bashrc ]]; then source ~/.bashrc; fi
__litecode_cwd() {
    local previous=$?
    printf '\033]9;9;"%s"\033\\' "$(pwd -W 2>/dev/null || pwd)"
    return "$previous"
}
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then
    PROMPT_COMMAND+=(__litecode_cwd)
else
    PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }__litecode_cwd"
fi
if [[ -n ${LITECODE_INITIAL_CWD:-} ]]; then cd -- "$LITECODE_INITIAL_CWD"; fi
