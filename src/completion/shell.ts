export function shellScript(shell: string): string {
  switch (shell) {
    case "bash":
      return BASH_SCRIPT;
    case "zsh":
      return ZSH_SCRIPT;
    case "fish":
      return FISH_SCRIPT;
    default:
      throw new Error(`Unsupported shell: ${shell}. Use one of: bash, zsh, fish.`);
  }
}

export const BASH_SCRIPT = `# hive bash completion
# Install: eval "$(hive completion bash)"
# Or add to ~/.bashrc: hive completion bash > ~/.hive.bash && source ~/.hive.bash
_hive_complete() {
  local IFS=$'\\n'
  local response
  response=$("\${COMP_WORDS[0]}" __complete "\${COMP_WORDS[@]}" 2>/dev/null)
  COMPREPLY=( $(compgen -W "$response" -- "\${COMP_WORDS[COMP_CWORD]}") )
}
complete -F _hive_complete hive
`;

export const ZSH_SCRIPT = `#compdef hive
# hive zsh completion
# Install: eval "$(hive completion zsh)"
# Or add to a directory in $fpath as _hive: hive completion zsh > ~/.zsh/completions/_hive
_hive() {
  local -a candidates
  candidates=( "\${(@f)\$("\${words[1]}" __complete "\${words[@]}" 2>/dev/null)}" )
  compadd -a candidates
}
compdef _hive hive
`;

export const FISH_SCRIPT = `# hive fish completion
# Install: hive completion fish | source
# Or add to ~/.config/fish/completions/hive.fish
function __hive_complete
  hive __complete (commandline -opc) (commandline -ct) 2>/dev/null
end
complete -c hive -f -a '(__hive_complete)'
`;
